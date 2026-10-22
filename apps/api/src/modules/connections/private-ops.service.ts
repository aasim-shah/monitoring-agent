import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { transition, type ConnectorRegistry } from '@pcp/connector-sdk';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { ConnectionStatus, TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException } from '../../common/errors.js';
import type { AgentIdentity } from '../../common/request.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { agentStatus } from '../agents/status.js';
import { TasksService, type TaskResultBody } from '../agents/tasks.service.js';
import { CONNECTOR_REGISTRY } from './registry.provider.js';

/** Health checks for private connections run every 5 minutes (WB-07 UC-07-04). */
const HEALTH_EVERY_MS = 5 * 60_000;
const MAX_DETAIL_BYTES = 256 * 1024;
/** BR-07-07. */
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Credentials never travel through the control plane for private connections (BR-07-01). */
const SECRET_KEYS =
  /^(password|passwd|pwd|secret|token|api_?key|apikey|credentials?|private_?key|connection_?string|uri|url_with_password)$/i;

export type PrivateOperation = 'validate' | 'health' | 'template';

interface PrivateConnection {
  id: string;
  provider: string;
  status: ConnectionStatus;
  statusReason: string | null;
  config: Prisma.JsonValue;
}

const configOf = (c: { config: Prisma.JsonValue }) => (c.config ?? {}) as Record<string, unknown>;

/**
 * Private connections (WB-07): operations become signed `connector_op` tasks for the
 * connection's private worker; results update the connection and its health.
 */
@Injectable()
export class PrivateOpsService implements OnModuleInit {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit() {
    this.tasks.onPoll((ctx, agent) => this.queueDueHealth(ctx, agent));
    this.tasks.onResult((ctx, agent, task, body) =>
      task.type === 'connector_op' ? this.applyResult(ctx, agent, task.payload, body) : Promise.resolve(),
    );
  }

  /** A private connection names an active private worker of this organization and a local secret. */
  async assertConfig(ctx: TenantContext, config: Record<string, unknown>): Promise<void> {
    const bad = (m: string) => new ApiException(400, 'validation_failed', m);
    const leaked = Object.keys(config).filter((k) => SECRET_KEYS.test(k));
    if (leaked.length)
      throw bad(`Credentials stay on the private worker; remove ${leaked.join(', ')} and use secretRef`);
    if (
      typeof config.secretRef !== 'string' ||
      !SECRET_REF.test(config.secretRef) ||
      config.secretRef.includes('..')
    )
      throw bad('secretRef must be a simple name (letters, digits, . _ -)');
    const workerId = config.workerAgentId;
    if (typeof workerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workerId))
      throw bad('workerAgentId is required');
    const worker = await withTenant(this.prisma, ctx, (tx) =>
      tx.agent.findUnique({ where: { id: workerId }, select: { agentType: true, status: true } }),
    );
    if (!worker || worker.agentType !== 'private_worker' || worker.status !== 'active')
      throw bad('workerAgentId must be an active private worker in this organization');
  }

  async dispatch(
    ctx: TenantContext,
    connection: { id: string; provider: string; config: Prisma.JsonValue },
    operation: PrivateOperation,
    extra: { template?: string; params?: { from: string; to: string } } = {},
  ): Promise<string> {
    const config = configOf(connection);
    const task = await this.tasks.create(ctx, String(config.workerAgentId), {
      type: 'connector_op',
      payload: { connectionId: connection.id, provider: connection.provider, operation, config, ...extra },
      resourceScope: { connectionId: connection.id },
      ttlSeconds: 600,
      maxRuntimeSeconds: 60,
      maxResponseBytes: MAX_DETAIL_BYTES,
    });
    return task.id;
  }

  templateNames(provider: string): string[] {
    return (this.registry.get(provider).templates ?? []).map((t) => t.name);
  }

  /** Read-time status: an offline worker makes the connection `degraded / worker_offline`, never a stale "connected". */
  async effectiveStatus(
    ctx: TenantContext,
    c: { executionLocation: string; status: string; statusReason: string | null; config: Prisma.JsonValue },
  ): Promise<{ status: string; statusReason: string | null }> {
    if (c.executionLocation !== 'private' || ['disconnected', 'revoked'].includes(c.status))
      return { status: c.status, statusReason: c.statusReason };
    const workerId = configOf(c).workerAgentId;
    const worker =
      typeof workerId === 'string'
        ? await withTenant(this.prisma, ctx, (tx) =>
            tx.agent.findUnique({
              where: { id: workerId },
              select: { status: true, lastHeartbeatAt: true, createdAt: true },
            }),
          )
        : null;
    const derived = worker ? agentStatus(worker, this.now()) : { status: 'revoked', stale: true };
    if (derived.status !== 'active') return { status: 'degraded', statusReason: 'worker_offline' };
    return { status: c.status, statusReason: c.statusReason };
  }

  /** Called when a private worker polls: queue the health checks that are due (no API scheduler needed). */
  private async queueDueHealth(ctx: TenantContext, agent: AgentIdentity): Promise<void> {
    const due = await withTenant(this.prisma, ctx, async (tx) => {
      const connections = await tx.connection.findMany({
        where: {
          executionLocation: 'private',
          status: { in: ['connected', 'degraded'] },
          config: { path: ['workerAgentId'], equals: agent.id },
        },
        select: {
          id: true,
          provider: true,
          config: true,
          health: { orderBy: { checkedAt: 'desc' }, take: 1 },
        },
      });
      const out = [];
      for (const c of connections) {
        const last = c.health[0]?.checkedAt;
        if (last && this.now().getTime() - last.getTime() < HEALTH_EVERY_MS) continue;
        const pending = await tx.agentTask.count({
          where: {
            agentId: agent.id,
            type: 'connector_op',
            status: { in: ['queued', 'delivered'] },
            payload: { path: ['connectionId'], equals: c.id },
          },
        });
        if (!pending) out.push(c);
      }
      return out;
    });
    for (const c of due) await this.dispatch(ctx, c, 'health');
  }

  private async applyResult(
    ctx: TenantContext,
    agent: AgentIdentity,
    payload: Record<string, unknown>,
    body: TaskResultBody,
  ): Promise<void> {
    const connectionId = String(payload.connectionId ?? '');
    const operation = payload.operation as PrivateOperation;
    const connection = await withTenant(this.prisma, ctx, (tx) =>
      tx.connection.findUnique({
        where: { id: connectionId },
        select: { id: true, provider: true, status: true, statusReason: true, config: true },
      }),
    );
    // Only the connection's own worker may report on it (Review Focus #3).
    if (!connection || configOf(connection).workerAgentId !== agent.id) return;
    const reason = typeof body.result?.reason === 'string' ? body.result.reason : 'provider_unavailable';
    const ok = body.status === 'succeeded' && body.result?.ok !== false;
    if (operation === 'validate') {
      const updated = await this.setStatus(
        ctx,
        connection,
        ok ? 'validated' : 'validation_failed',
        ok ? null : reason,
        ok,
      );
      if (ok && updated) await this.dispatch(ctx, connection, 'health');
    } else if (operation === 'health') {
      const detail = JSON.stringify(ok ? (body.result?.data ?? {}) : { error: body.error ?? reason });
      await withTenant(this.prisma, ctx, (tx) =>
        tx.connectionHealth.create({
          data: {
            organizationId: ctx.organizationId,
            connectionId,
            checkedAt: this.now(),
            ok,
            reason: ok ? null : reason,
            detail:
              Buffer.byteLength(detail) > MAX_DETAIL_BYTES ? JSON.stringify({ truncated: true }) : detail,
          },
        }),
      );
      if (!ok && connection.status === 'connected')
        await this.setStatus(ctx, connection, 'degraded', reason, false);
      if (ok && connection.status === 'degraded' && connection.statusReason !== 'permission_denied')
        await this.setStatus(ctx, connection, 'recovered', null, false);
    }
  }

  private async setStatus(
    ctx: TenantContext,
    c: PrivateConnection,
    event: Parameters<typeof transition>[1],
    statusReason: string | null,
    validated: boolean,
  ): Promise<boolean> {
    let next: ConnectionStatus;
    try {
      next = transition(c.status, event);
    } catch {
      return false; // e.g. disconnected meanwhile
    }
    await withTenant(this.prisma, ctx, (tx) =>
      tx.connection.update({
        where: { id: c.id },
        data: { status: next, statusReason, ...(validated ? { lastValidatedAt: this.now() } : {}) },
      }),
    );
    return true;
  }

  async health(ctx: TenantContext, connectionId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const rows = await tx.connectionHealth.findMany({
        where: { connectionId },
        orderBy: { checkedAt: 'desc' },
        take: 10,
      });
      const template = await tx.agentTask.findFirst({
        where: {
          type: 'connector_op',
          status: 'succeeded',
          AND: [
            { payload: { path: ['connectionId'], equals: connectionId } },
            { payload: { path: ['operation'], equals: 'template' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: { result: true },
      });
      const parse = (d: string | null) => {
        try {
          return d ? (JSON.parse(d) as unknown) : null;
        } catch {
          return null;
        }
      };
      const view = (h: (typeof rows)[number]) => ({
        checkedAt: h.checkedAt,
        ok: h.ok,
        reason: h.reason,
        data: parse(h.detail),
      });
      const r = template?.result?.result as Record<string, unknown> | undefined;
      return {
        latest: rows[0] ? view(rows[0]) : null,
        history: rows.map(view),
        lastTemplate: r
          ? {
              template: r.template,
              rows: r.rows,
              truncated: r.truncated === true,
              at: template!.result!.receivedAt,
            }
          : null,
      };
    });
  }
}
