import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  assessImpact,
  canApprove,
  CAPABILITIES,
  defaultApproverRoles,
  evaluatePolicy,
  isCapability,
  isProduction,
  type Capability,
  type PolicyLike,
} from '@pcp/automation';
import type { ConnectorRuntime } from '@pcp/connector-runtime';
import { Prisma, type ActionRequest, type PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException, notFound } from '../../common/errors.js';
import type { AgentIdentity } from '../../common/request.js';
import { APP_CONFIG, CLOCK, PRISMA } from '../../tokens.js';
import { TasksService, type TaskResultBody } from '../agents/tasks.service.js';
import { AuditService } from '../auditing/audit.service.js';
import { CONNECTOR_RUNTIME } from '../connections/registry.provider.js';
import {
  atLeast,
  MINIMUM_ACTION_AGENT_VERSION,
  MINIMUM_EXPORTER_AGENT_VERSION,
} from '../logs/agent-version.js';
import type { AppConfig } from '../../config.js';

type Tx = Prisma.TransactionClient;

/** An undecided request expires after 1 h; a signed task lives 10 min (WB-16 §4, BR-16-04). */
const APPROVAL_TTL_MS = 60 * 60_000;
const TASK_TTL_SECONDS = 600;
/** The helper waits up to 60 s for the unit plus a 3 s settle; the agent allows 90 s. */
const TASK_RUNTIME_SECONDS = 90;
const HOST_ADAPTER_VERSION = '0.3.0';
const PROVIDER_ADAPTER_VERSION = '1';

export interface ProposalInput {
  productId: string;
  environmentId: string;
  capability: string;
  target: Record<string, unknown>;
  params: Record<string, unknown>;
  idempotencyKey: string;
  reason?: string;
  incidentId?: string;
}

export interface PolicyInput {
  environmentId: string;
  enabled: boolean;
  approverRoles: string[];
  requireApproval: boolean;
  settings: Record<string, unknown>;
}

const requestView = (
  r: ActionRequest & {
    approvals?: Array<{ id: string; userId: string; decision: string; note: string | null; createdAt: Date }>;
    executions?: Array<Record<string, unknown>>;
  },
) => ({
  id: r.id,
  productId: r.productId,
  environmentId: r.environmentId,
  capability: r.capability,
  target: r.target,
  params: r.params,
  status: r.status,
  reason: r.reason,
  impact: r.impact,
  proposedByAi: r.proposedByAi,
  requestedByUserId: r.requestedByUserId,
  incidentId: r.incidentId,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  ...(r.approvals ? { approvals: r.approvals } : {}),
  ...(r.executions ? { executions: r.executions } : {}),
});

const executionView = (e: Prisma.ActionExecutionGetPayload<object>) => ({
  id: e.id,
  location: e.location,
  adapter: e.adapter,
  adapterVersion: e.adapterVersion,
  agentTaskId: e.agentTaskId,
  status: e.status,
  startedAt: e.startedAt,
  finishedAt: e.finishedAt,
  result: e.result,
  verification: e.verification,
  error: e.error,
});

/**
 * Operational actions (spec §13.5, WB-16): propose → policy → dry-run and impact → approval →
 * a signed, short-lived task → verification → audit. Nothing runs without an enabled policy
 * (BR-16-01); the AI only proposes (BR-16-02); one action per target at a time (BR-16-06).
 */
/** The pack whose service each managed exporter reads (M18.3). */
export const EXPORTER_BASE_PACK: Record<string, string> = {
  redis_exporter: 'redis',
  kafka_exporter: 'kafka',
};

@Injectable()
export class ActionsService implements OnModuleInit {
  private readonly logger = new Logger('Actions');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
    @Inject(CONNECTOR_RUNTIME) private readonly runtime: ConnectorRuntime,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.tasks.onResult((ctx, agent, task, body) =>
      task.type === 'action' ? this.onTaskResult(ctx, agent, task.id, body) : Promise.resolve(),
    );
  }

  // ---------- policies (UC-16-01) ----------

  /** Every capability for every environment of the product; missing rows are the disabled default. */
  async policies(ctx: TenantContext, productId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const [envs, rows] = await Promise.all([
        tx.environment.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } }),
        tx.actionPolicy.findMany({ where: { productId } }),
      ]);
      const providers = new Set(
        (
          await tx.connection.findMany({
            where: { status: { in: ['connected', 'degraded'] }, scopes: { some: { productId } } },
            select: { provider: true },
          })
        ).map((c) => c.provider),
      );
      const policies = envs.flatMap((env) =>
        (Object.keys(CAPABILITIES) as Capability[]).map((capability) => {
          const row = rows.find((r) => r.environmentId === env.id && r.capability === capability);
          const production = isProduction(env.name);
          return {
            id: row?.id ?? null,
            environmentId: env.id,
            environmentName: env.name,
            production,
            capability,
            label: CAPABILITIES[capability].label,
            enabled: row?.enabled ?? false,
            approverRoles: row?.approverRoles.length ? row.approverRoles : defaultApproverRoles(production),
            requireApproval: row?.requireApproval ?? true,
            settings: row?.settings ?? {},
            // Cloudflare and GitHub actions need a connected, product-scoped connection (M7).
            available:
              CAPABILITIES[capability].location === 'agent' || providers.has(capability.split('.')[0]!),
          };
        }),
      );
      return { policies };
    });
  }

  async putPolicy(ctx: TenantContext, productId: string, capability: string, input: PolicyInput) {
    if (!isCapability(capability)) throw notFound();
    return withTenant(this.prisma, ctx, async (tx) => {
      const env = await tx.environment.findFirst({ where: { id: input.environmentId, productId } });
      if (!env)
        throw new ApiException(400, 'invalid_environment', 'The environment is not part of this product');
      const data = {
        enabled: input.enabled,
        approverRoles: input.approverRoles,
        requireApproval: input.requireApproval,
        settings: input.settings as Prisma.InputJsonValue,
        updatedByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
      };
      const row = await tx.actionPolicy.upsert({
        where: { productId_environmentId_capability: { productId, environmentId: env.id, capability } },
        create: { organizationId: ctx.organizationId, productId, environmentId: env.id, capability, ...data },
        update: data,
      });
      await this.audit.record(tx, ctx, {
        action: 'action_policy.update',
        targetType: 'action_policy',
        targetId: row.id,
        metadata: { capability, environment: env.name, enabled: input.enabled, settings: input.settings },
      });
      return { id: row.id, capability, environmentId: env.id, enabled: row.enabled };
    });
  }

  // ---------- proposals (UC-16-02/03/04) ----------

  async propose(ctx: TenantContext, input: ProposalInput, opts: { proposedByAi: boolean }) {
    if (!isCapability(input.capability)) throw new ApiException(400, 'invalid_capability', 'Unknown action');
    const capability = input.capability;
    const def = CAPABILITIES[capability];
    const prior = await withTenant(this.prisma, ctx, (tx) =>
      tx.actionRequest.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: ctx.organizationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      }),
    );
    if (prior) {
      if (prior.productId !== input.productId) throw notFound();
      return requestView(prior);
    }
    const created = await withTenant(this.prisma, ctx, async (tx) => {
      const env = await tx.environment.findFirst({
        where: { id: input.environmentId, productId: input.productId },
      });
      if (!env)
        throw new ApiException(400, 'invalid_environment', 'The environment is not part of this product');
      const target = await this.resolveTarget(tx, capability, input, env.id);
      const policy = await tx.actionPolicy.findUnique({
        where: {
          productId_environmentId_capability: {
            productId: input.productId,
            environmentId: env.id,
            capability,
          },
        },
      });
      const decision = evaluatePolicy(
        policy ? (policy as unknown as PolicyLike) : null,
        { capability, target: input.target, params: input.params, proposedByAi: opts.proposedByAi },
        env,
      );
      const impact = assessImpact({
        action: target.action,
        dependents: target.agentId ? await this.dependents(tx, target.agentId) : [],
      });
      const request = await tx.actionRequest.create({
        data: {
          organizationId: ctx.organizationId,
          productId: input.productId,
          environmentId: env.id,
          capability,
          target: input.target as Prisma.InputJsonValue,
          targetKey: def.targetKey(input.target, input.params),
          params: input.params as Prisma.InputJsonValue,
          status: decision.decision,
          reason: decision.decision === 'rejected_policy' ? decision.reason : (input.reason ?? null),
          impact: {
            ...impact,
            policyDecision: decision.decision,
            policyReason: decision.reason,
            host: target.label,
          } as unknown as Prisma.InputJsonValue,
          proposedByAi: opts.proposedByAi,
          requestedByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
          idempotencyKey: input.idempotencyKey,
          incidentId: input.incidentId ?? null,
          expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS),
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'action.propose',
        targetType: 'action_request',
        targetId: request.id,
        metadata: {
          capability,
          target: input.target,
          params: input.params,
          proposedByAi: opts.proposedByAi,
          policyDecision: decision.decision,
          policyReason: decision.reason,
        },
      });
      return request;
    });
    if (created.status === 'approved') return requestView(await this.tryExecute(ctx, created.id));
    return requestView(created);
  }

  /**
   * The thing an action changes: a host with pcp-helper (agent 0.3.0+), or a provider
   * connection of the capability's provider, connected and scoped to this product (M7).
   */
  private async resolveTarget(
    tx: Tx,
    capability: Capability,
    input: ProposalInput,
    environmentId: string,
  ): Promise<{ label: string; action: string; agentId?: string }> {
    if (CAPABILITIES[capability].location === 'platform') {
      const provider = capability.split('.')[0]!;
      const connectionId = String(input.target.connectionId ?? '');
      const c = /^[0-9a-f-]{36}$/i.test(connectionId)
        ? await tx.connection.findFirst({
            where: {
              id: connectionId,
              provider,
              status: { in: ['connected', 'degraded'] },
              scopes: { some: { productId: input.productId } },
            },
          })
        : null;
      if (!c)
        throw new ApiException(
          409,
          'connection_required',
          `${CAPABILITIES[capability].label} needs a connected ${provider} connection for this product`,
        );
      if (capability === 'cloudflare.purge_cache') {
        const zoneId = String(input.target.zoneId ?? '');
        const zone = await tx.connectionInventoryItem.findFirst({
          where: { connectionId: c.id, resourceType: 'cloudflare_zone', externalId: zoneId },
        });
        const scope = await tx.connectionResourceScope.findFirst({
          where: { connectionId: c.id, externalId: zoneId },
        });
        const label = zone?.name ?? scope?.name ?? zoneId;
        const urls = Array.isArray(input.params.urls) ? input.params.urls.length : 0;
        return {
          label,
          action:
            input.params.everything === true
              ? `Purging the whole Cloudflare cache of ${label}`
              : `Purging ${urls} URL${urls === 1 ? '' : 's'} from the Cloudflare cache of ${label}`,
        };
      }
      const repo = String(input.target.repo ?? '');
      return {
        label: repo,
        action: `Running workflow ${String(input.params.workflow)} on ${String(input.params.ref)} in ${repo}`,
      };
    }
    const agent = await tx.agent.findUnique({ where: { id: String(input.target.agentId ?? '') } });
    if (!agent || agent.productId !== input.productId || agent.environmentId !== environmentId)
      throw new ApiException(400, 'invalid_target', 'The host is not part of this product environment');
    if (agent.status === 'revoked') throw new ApiException(409, 'agent_revoked', 'This agent is revoked');
    const exporter = capability === 'host.install_exporter' || capability === 'host.remove_exporter';
    const minimum = exporter ? MINIMUM_EXPORTER_AGENT_VERSION : MINIMUM_ACTION_AGENT_VERSION;
    if (!atLeast(agent.agentVersion, minimum))
      throw new ApiException(
        409,
        'agent_upgrade_required',
        `${exporter ? 'Managed exporters' : 'Actions'} need agent ${minimum} or later with pcp-helper; ${agent.hostname} runs ${agent.agentVersion}`,
      );
    if (exporter) {
      const name = String(input.params.exporter ?? '');
      if (capability === 'host.install_exporter') {
        const base = await tx.agentPackAssignment.findFirst({
          where: { agentId: agent.id, packId: EXPORTER_BASE_PACK[name] ?? '', status: 'applied' },
        });
        if (!base)
          throw new ApiException(
            409,
            'pack_not_enabled',
            `${name} reads the ${EXPORTER_BASE_PACK[name]} pack's service; enable that pack on ${agent.hostname} first`,
          );
      }
      return {
        label: agent.hostname,
        action:
          capability === 'host.install_exporter'
            ? `Installing ${name} on ${agent.hostname} (Level 1, 127.0.0.1 only)`
            : `Removing ${name} from ${agent.hostname}`,
        agentId: agent.id,
      };
    }
    return {
      label: agent.hostname,
      action: `Restarting ${String(input.params.unit ?? '')} on ${agent.hostname}`,
      agentId: agent.id,
    };
  }

  /** Assets the host serves or that depend on what it serves (dry-run impact, UC-16-04). */
  private async dependents(tx: Tx, agentId: string) {
    const host = await tx.asset.findFirst({
      where: { identityKey: `agent:${agentId}` },
      select: { id: true },
    });
    if (!host) return [];
    const hosted = await tx.assetRelationship.findMany({
      where: { sourceAssetId: host.id, verification: { not: 'rejected' } },
      select: { target: { select: { id: true, name: true, assetType: true } } },
    });
    const ids = hosted.map((h) => h.target.id);
    const dependents = ids.length
      ? await tx.assetRelationship.findMany({
          where: {
            targetAssetId: { in: ids },
            relationshipType: 'DEPENDS_ON',
            verification: { not: 'rejected' },
          },
          select: { source: { select: { id: true, name: true, assetType: true } } },
        })
      : [];
    const all = new Map<string, { name: string; type: string }>();
    for (const a of [...hosted.map((h) => h.target), ...dependents.map((d) => d.source)])
      all.set(a.id, { name: a.name, type: a.assetType });
    return [...all.values()];
  }

  // ---------- reading (with lazy expiry) ----------

  async list(ctx: TenantContext, productId: string, status?: string) {
    await this.expireDue(ctx);
    const rows = await withTenant(this.prisma, ctx, (tx) =>
      tx.actionRequest.findMany({
        where: { productId, ...(status ? { status: status as ActionRequest['status'] } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
    return { actions: rows.map((r) => requestView(r)) };
  }

  async get(ctx: TenantContext, id: string) {
    await this.expireDue(ctx);
    const r = await withTenant(this.prisma, ctx, (tx) =>
      tx.actionRequest.findUnique({
        where: { id },
        include: {
          approvals: { orderBy: { createdAt: 'asc' } },
          executions: { orderBy: { startedAt: 'asc' } },
        },
      }),
    );
    if (!r) throw notFound();
    return requestView({ ...r, executions: r.executions.map(executionView) });
  }

  async executions(ctx: TenantContext, id: string) {
    return { executions: (await this.get(ctx, id)).executions };
  }

  // ---------- decisions (UC-16-05) ----------

  async approve(ctx: TenantContext, id: string, note?: string) {
    await this.expireDue(ctx);
    const outcome = await withTenant(this.prisma, ctx, async (tx) => {
      const r = await tx.actionRequest.findUnique({
        where: { id },
        include: { approvals: true, environment: true },
      });
      if (!r) throw notFound();
      if (r.status !== 'pending_approval')
        throw new ApiException(409, 'not_pending', `This request is ${r.status.replace('_', ' ')}`);
      const policy = await tx.actionPolicy.findUnique({
        where: {
          productId_environmentId_capability: {
            productId: r.productId,
            environmentId: r.environmentId,
            capability: r.capability,
          },
        },
      });
      if (!policy?.enabled)
        throw new ApiException(409, 'policy_disabled', 'The policy for this action was turned off');
      const userId = ctx.actor.kind === 'user' ? ctx.actor.userId : '';
      const check = canApprove({
        request: {
          requestedByUserId: r.requestedByUserId,
          capability: r.capability as Capability,
          params: r.params as Record<string, unknown>,
        },
        approver: { userId, roles: ctx.roles },
        approvals: r.approvals,
        policy: policy as unknown as PolicyLike,
        production: isProduction(r.environment.name),
      });
      if (!check.ok) {
        await this.audit.record(tx, ctx, {
          action: 'action.approve_refused',
          targetType: 'action_request',
          targetId: id,
          metadata: { code: check.code },
        });
        return { refused: check };
      }
      await tx.actionApproval.create({
        data: {
          organizationId: ctx.organizationId,
          requestId: id,
          userId,
          decision: 'approve',
          note: note ?? null,
        },
      });
      if (check.complete) await tx.actionRequest.update({ where: { id }, data: { status: 'approved' } });
      await this.audit.record(tx, ctx, {
        action: 'action.approve',
        targetType: 'action_request',
        targetId: id,
        metadata: { complete: check.complete, note: note ?? null },
      });
      return { complete: check.complete };
    });
    // The refusal is audited (committed) before the error goes back.
    if ('refused' in outcome && outcome.refused)
      throw new ApiException(403, outcome.refused.code, outcome.refused.reason);
    if (outcome.complete) return requestView(await this.tryExecute(ctx, id));
    return this.get(ctx, id);
  }

  async reject(ctx: TenantContext, id: string, note: string) {
    await this.expireDue(ctx);
    return withTenant(this.prisma, ctx, async (tx) => {
      const r = await tx.actionRequest.findUnique({ where: { id }, include: { environment: true } });
      if (!r) throw notFound();
      if (r.status !== 'pending_approval')
        throw new ApiException(409, 'not_pending', `This request is ${r.status.replace('_', ' ')}`);
      const policy = await tx.actionPolicy.findUnique({
        where: {
          productId_environmentId_capability: {
            productId: r.productId,
            environmentId: r.environmentId,
            capability: r.capability,
          },
        },
      });
      const roles = policy?.approverRoles.length
        ? policy.approverRoles
        : defaultApproverRoles(isProduction(r.environment.name));
      if (!ctx.roles.some((role) => roles.includes(role)))
        throw new ApiException(403, 'not_an_approver', `Approvers for this policy: ${roles.join(', ')}`);
      const userId = ctx.actor.kind === 'user' ? ctx.actor.userId : '';
      await tx.actionApproval.upsert({
        where: { requestId_userId: { requestId: id, userId } },
        create: { organizationId: ctx.organizationId, requestId: id, userId, decision: 'reject', note },
        update: { decision: 'reject', note },
      });
      const updated = await tx.actionRequest.update({
        where: { id },
        data: { status: 'rejected', reason: note },
      });
      await this.audit.record(tx, ctx, {
        action: 'action.reject',
        targetType: 'action_request',
        targetId: id,
        metadata: { note, capability: r.capability, target: r.target },
      });
      return requestView(updated);
    });
  }

  // ---------- execution (spec §13.5 H–K) ----------

  /**
   * Runs an approved request when its target is free: claims the target (one running execution
   * per target), then issues a new signed task. A busy target leaves the request `approved`; it
   * runs when the current execution finishes (TC-16-04).
   */
  private async tryExecute(ctx: TenantContext, id: string): Promise<ActionRequest> {
    const claimed = await withTenant(this.prisma, ctx, async (tx) => {
      const r = await tx.actionRequest.findUnique({
        where: { id },
        include: { approvals: { where: { decision: 'approve' }, orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (!r || r.status !== 'approved') return { request: r, execution: null };
      try {
        const execution = await tx.actionExecution.create({
          data: {
            organizationId: ctx.organizationId,
            requestId: id,
            targetKey: r.targetKey,
            runningKey: r.targetKey,
            location: CAPABILITIES[r.capability as Capability].location,
            adapter: r.capability,
            adapterVersion:
              CAPABILITIES[r.capability as Capability].location === 'agent'
                ? HOST_ADAPTER_VERSION
                : PROVIDER_ADAPTER_VERSION,
            startedAt: this.now(),
          },
        });
        const request = await tx.actionRequest.update({ where: { id }, data: { status: 'executing' } });
        return { request, execution, approvalId: r.approvals[0]?.id ?? r.id };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
          return { request: r, execution: null };
        throw err;
      }
    });
    if (!claimed.execution || !claimed.request) return claimed.request!;
    const r = claimed.request;
    if (CAPABILITIES[r.capability as Capability].location === 'platform') {
      // Provider calls (and GitHub's run check, up to 30 s) finish in the background.
      void this.runProvider(ctx, claimed.execution.id, r);
      return r;
    }
    const target = r.target as { agentId: string };
    const unit = String((r.params as { unit?: string }).unit);
    try {
      const { payload, scope } = await this.helperPayload(ctx, r, target.agentId, unit);
      // A new task per approval; tasks are never reused (BR-16-04, WB-16 §9).
      const task = await this.tasks.create(ctx, target.agentId, {
        type: 'action',
        payload,
        resourceScope: scope,
        ttlSeconds: TASK_TTL_SECONDS,
        maxRuntimeSeconds: TASK_RUNTIME_SECONDS,
        maxResponseBytes: 4096,
        approvalId: claimed.approvalId!,
      });
      await withTenant(this.prisma, ctx, (tx) =>
        tx.actionExecution.update({ where: { id: claimed.execution!.id }, data: { agentTaskId: task.id } }),
      );
      return r;
    } catch (err) {
      await this.finish(ctx, claimed.execution.id, {
        status: 'failed',
        error: (err as Error).message,
        result: null,
        verification: null,
      });
      return (await withTenant(this.prisma, ctx, (tx) => tx.actionRequest.findUnique({ where: { id } })))!;
    }
  }

  /**
   * What pcp-helper runs: a service restart, or a Level 1 exporter install or removal (M18.3).
   * The exporter reads the base pack's service at its configured loopback endpoint.
   */
  private async helperPayload(
    ctx: TenantContext,
    r: ActionRequest,
    agentId: string,
    unit: string,
  ): Promise<{ payload: Record<string, unknown>; scope: Record<string, string> }> {
    if (r.capability === 'host.restart_service')
      return { payload: { capability: 'service_restart', unit }, scope: { agentId, unit } };
    const exporter = String((r.params as { exporter?: string }).exporter);
    if (r.capability === 'host.remove_exporter')
      return { payload: { capability: 'pack_remove', exporter }, scope: { agentId, exporter } };
    const base = await withTenant(this.prisma, ctx, (tx) =>
      tx.agentPackAssignment.findFirst({ where: { agentId, packId: EXPORTER_BASE_PACK[exporter] ?? '' } }),
    );
    const endpoint = String((base?.settings as { endpoint?: string } | null)?.endpoint ?? '');
    return {
      payload: {
        capability: 'pack_install',
        exporter,
        downloadUrl: `${this.config.appOrigin}/downloads`,
        target: endpoint,
      },
      scope: { agentId, exporter },
    };
  }

  /** Cloudflare purge or GitHub dispatch through the connection's connector (M7). */
  private async runProvider(ctx: TenantContext, executionId: string, r: ActionRequest) {
    const target = r.target as { connectionId: string; zoneId?: string; repo?: string };
    const params = r.params as Record<string, unknown>;
    const action =
      r.capability === 'cloudflare.purge_cache'
        ? {
            kind: 'purge_cache',
            zoneId: target.zoneId,
            ...(params.everything === true ? { everything: true } : { urls: params.urls }),
          }
        : { kind: 'workflow_dispatch', repo: target.repo, workflow: params.workflow, ref: params.ref };
    try {
      const out = (await this.runtime.executeAction(ctx, target.connectionId, action)) as
        | { ok: true; result: Record<string, unknown>; verification: Record<string, unknown> }
        | { ok: false; error: string; verification?: Record<string, unknown> };
      await this.finish(
        ctx,
        executionId,
        out.ok
          ? { status: 'succeeded', error: null, result: out.result, verification: out.verification }
          : { status: 'failed', error: out.error, result: null, verification: out.verification ?? null },
      );
    } catch (err) {
      await this.finish(ctx, executionId, {
        status: 'failed',
        error: (err as Error).message.slice(0, 500),
        result: null,
        verification: null,
      }).catch((e) => this.logger.error(`action ${r.id}: ${String(e)}`));
    }
  }

  /** The agent's answer for an action task: verify, record, audit, and start the next on the target. */
  private async onTaskResult(
    ctx: TenantContext,
    _agent: AgentIdentity,
    taskId: string,
    body: TaskResultBody,
  ) {
    const execution = await withTenant(this.prisma, ctx, (tx) =>
      tx.actionExecution.findFirst({ where: { agentTaskId: taskId, status: 'running' } }),
    );
    if (!execution) return;
    const result = body.result ?? {};
    // Never succeeded without verification. A restart: the unit is active. An exporter install
    // (M18.3): the helper saw it answer on loopback. A removal: unit, binary, and user are gone.
    let verified: boolean;
    let verification: Record<string, unknown>;
    let failure: string;
    if (execution.adapter === 'host.install_exporter') {
      const listen = typeof result.listen === 'string' ? result.listen : null;
      verified = body.status === 'succeeded' && !!listen?.startsWith('127.0.0.1:');
      verification = { listen, verified };
      failure = 'Verification failed: the exporter is not listening on 127.0.0.1';
    } else if (execution.adapter === 'host.remove_exporter') {
      verified = body.status === 'succeeded' && result.removed === true;
      verification = { removed: result.removed === true, verified };
      failure = 'Verification failed: the exporter was not removed';
    } else {
      const activeState = typeof result.activeState === 'string' ? result.activeState : null;
      verified = body.status === 'succeeded' && activeState === 'active';
      verification = { activeState, verified };
      failure = `Verification failed: the unit is ${activeState ?? 'unknown'}`;
    }
    await this.finish(ctx, execution.id, {
      status: verified ? 'succeeded' : 'failed',
      error: verified ? null : (body.error ?? failure),
      result,
      verification,
    });
  }

  private async finish(
    ctx: TenantContext,
    executionId: string,
    outcome: {
      status: 'succeeded' | 'failed' | 'expired';
      error: string | null;
      result: Record<string, unknown> | null;
      verification: Record<string, unknown> | null;
    },
  ) {
    const targetKey = await withTenant(this.prisma, ctx, async (tx) => {
      const finishedAt = this.now();
      const e = await tx.actionExecution.update({
        where: { id: executionId },
        data: {
          status: outcome.status,
          runningKey: null,
          finishedAt,
          error: outcome.error,
          result: (outcome.result ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          verification: (outcome.verification ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      const r = await tx.actionRequest.update({
        where: { id: e.requestId },
        data: { status: outcome.status, ...(outcome.error ? { reason: outcome.error } : {}) },
        include: { approvals: { where: { decision: 'approve' } } },
      });
      const impact = r.impact as { policyDecision?: string };
      // BR-16-08: everything an auditor needs about this action, in one row.
      await this.audit.record(tx, ctx, {
        action: outcome.status === 'expired' ? 'action.expire' : 'action.execute',
        targetType: 'action_request',
        targetId: r.id,
        metadata: {
          initiator: r.requestedByUserId,
          proposedByAi: r.proposedByAi,
          target: r.target,
          capability: r.capability,
          policyDecision: impact.policyDecision ?? null,
          approvers: r.approvals.map((a) => a.userId),
          executionLocation: e.location,
          adapter: e.adapter,
          adapterVersion: e.adapterVersion,
          startedAt: e.startedAt,
          finishedAt,
          result: outcome.status === 'succeeded' ? 'succeeded' : (outcome.error ?? outcome.status),
          verification: outcome.verification,
        },
      });
      if (r.incidentId)
        await tx.incidentEvent.create({
          data: {
            organizationId: ctx.organizationId,
            incidentId: r.incidentId,
            kind: 'note',
            detail: {
              note: `Action ${CAPABILITIES[r.capability as Capability]?.label ?? r.capability}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ''}`,
              actionId: r.id,
            },
            at: finishedAt,
          },
        });
      return r.targetKey;
    });
    await this.startNext(ctx, targetKey);
  }

  /** The oldest approved request waiting for this target (BR-16-06). */
  private async startNext(ctx: TenantContext, targetKey: string) {
    const next = await withTenant(this.prisma, ctx, (tx) =>
      tx.actionRequest.findFirst({ where: { targetKey, status: 'approved' }, orderBy: { updatedAt: 'asc' } }),
    );
    if (next) await this.tryExecute(ctx, next.id);
  }

  /**
   * Lazy expiry, as agent tasks expire on poll: undecided requests after 1 h, and executions
   * whose task outlived its TTL and runtime without a result (agent offline, WB-16 §9).
   */
  private async expireDue(ctx: TenantContext) {
    const now = this.now();
    const stale = await withTenant(this.prisma, ctx, async (tx) => {
      const pending = await tx.actionRequest.findMany({
        where: { status: { in: ['pending_approval', 'approved'] }, expiresAt: { lt: now } },
        select: { id: true, status: true },
      });
      for (const p of pending) {
        // An approved request waiting for its target does not expire while it waits.
        if (p.status === 'approved') continue;
        await tx.actionRequest.update({
          where: { id: p.id },
          data: { status: 'expired', reason: 'No decision within 1 hour' },
        });
        await this.audit.record(tx, ctx, {
          action: 'action.expire',
          targetType: 'action_request',
          targetId: p.id,
          metadata: { reason: 'No decision within 1 hour' },
        });
      }
      const running = await tx.actionExecution.findMany({ where: { status: 'running' } });
      const overdue: string[] = [];
      for (const e of running) {
        const task = e.agentTaskId ? await tx.agentTask.findUnique({ where: { id: e.agentTaskId } }) : null;
        const deadline = task
          ? task.expiresAt.getTime() + task.maxRuntimeSeconds * 1000
          : e.startedAt.getTime() + TASK_TTL_SECONDS * 1000;
        if (task?.status === 'expired' || deadline < now.getTime()) overdue.push(e.id);
      }
      return overdue;
    });
    for (const id of stale)
      await this.finish(ctx, id, {
        status: 'expired',
        error: 'The host did not run the task within 10 minutes (agent offline?)',
        result: null,
        verification: null,
      });
  }
}
