import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { validateMessage, type AgentTask } from '@pcp/agent-protocol';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { Redis } from 'ioredis';
import { ApiException, notFound } from '../../common/errors.js';
import type { AgentIdentity } from '../../common/request.js';
import { CLOCK, PRISMA, REDIS } from '../../tokens.js';
import { AGENT_SETTINGS, requireSettings, type AgentSettings } from './settings.provider.js';
import { TaskNotifier } from './task-notifier.js';

const MAX_WAIT_SECONDS = 25;

export interface NewTask {
  type: AgentTask['type'];
  payload: Record<string, unknown>;
  resourceScope?: Record<string, string>;
  ttlSeconds?: number;
  maxRuntimeSeconds?: number;
  maxResponseBytes?: number;
}

type TaskRow = Prisma.AgentTaskGetPayload<object>;

/** The wire form the agent verifies; must match exactly what was signed. */
function wireTask(row: TaskRow): AgentTask {
  return {
    id: row.id,
    type: row.type as AgentTask['type'],
    expiresAt: row.expiresAt.toISOString(),
    resourceScope: row.resourceScope as Record<string, string>,
    maxRuntimeSeconds: row.maxRuntimeSeconds,
    maxResponseBytes: row.maxResponseBytes,
    ...(row.approvalId ? { approvalId: row.approvalId } : {}),
    payload: row.payload as Record<string, unknown>,
    signature: row.signature,
  };
}

/** Signed, expiring agent tasks and their streams (spec §8.4, D14). */
@Injectable()
export class TasksService implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AGENT_SETTINGS) private readonly settings: AgentSettings | null,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly notifier: TaskNotifier,
  ) {}

  onApplicationShutdown() {
    this.notifier.close();
  }

  async create(ctx: TenantContext, agentId: string, input: NewTask): Promise<AgentTask> {
    const { signer } = requireSettings(this.settings);
    const unsigned = {
      id: randomUUID(),
      type: input.type,
      expiresAt: new Date(this.now().getTime() + (input.ttlSeconds ?? 600) * 1000).toISOString(),
      resourceScope: input.resourceScope ?? {},
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? 60,
      maxResponseBytes: input.maxResponseBytes ?? 65_536,
      payload: input.payload,
    };
    const signature = signer.sign(unsigned);
    const row = await withTenant(this.prisma, ctx, async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { status: true } });
      if (!agent) throw notFound();
      if (agent.status === 'revoked') throw new ApiException(409, 'agent_revoked', 'This agent is revoked');
      return tx.agentTask.create({
        data: {
          id: unsigned.id,
          organizationId: ctx.organizationId,
          agentId,
          type: unsigned.type,
          payload: unsigned.payload as Prisma.InputJsonValue,
          resourceScope: unsigned.resourceScope,
          expiresAt: new Date(unsigned.expiresAt),
          maxRuntimeSeconds: unsigned.maxRuntimeSeconds,
          maxResponseBytes: unsigned.maxResponseBytes,
          signature,
          createdByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
        },
      });
    });
    await this.notifier.notify(agentId);
    return wireTask(row);
  }

  /**
   * Long-poll (D14): expires past-due tasks, claims queued unexpired ones, and otherwise
   * waits up to `waitSeconds` for a notification. Expired tasks are never delivered (BR-03-06).
   */
  async poll(ctx: TenantContext, agent: AgentIdentity, waitSeconds: number): Promise<AgentTask[]> {
    const claimed = await this.claim(ctx, agent.id);
    if (claimed.length || waitSeconds <= 0) return claimed;
    await this.notifier.wait(agent.id, Math.min(waitSeconds, MAX_WAIT_SECONDS) * 1000);
    return this.claim(ctx, agent.id);
  }

  private claim(ctx: TenantContext, agentId: string): Promise<AgentTask[]> {
    const now = this.now();
    return withTenant(this.prisma, ctx, async (tx) => {
      await tx.agentTask.updateMany({
        where: { agentId, status: 'queued', expiresAt: { lte: now } },
        data: { status: 'expired' },
      });
      const queued = await tx.agentTask.findMany({
        where: { agentId, status: 'queued', expiresAt: { gt: now } },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      const delivered: TaskRow[] = [];
      for (const task of queued) {
        // Conditional claim: a concurrent poll cannot deliver the same task twice.
        const { count } = await tx.agentTask.updateMany({
          where: { id: task.id, status: 'queued' },
          data: { status: 'delivered', deliveredAt: now },
        });
        if (count) delivered.push(task);
      }
      return delivered.map(wireTask);
    });
  }

  async result(
    ctx: TenantContext,
    agent: AgentIdentity,
    taskId: string,
    body: { status: 'succeeded' | 'failed'; result?: Record<string, unknown>; error?: string },
  ): Promise<void> {
    await withTenant(this.prisma, ctx, async (tx) => {
      const task = await tx.agentTask.findFirst({
        where: { id: taskId, agentId: agent.id, status: 'delivered' },
      });
      if (!task) throw notFound();
      const size =
        Buffer.byteLength(JSON.stringify(body.result ?? null)) + Buffer.byteLength(body.error ?? '');
      if (size > task.maxResponseBytes)
        throw new ApiException(413, 'result_too_large', `Result exceeds ${task.maxResponseBytes} bytes`);
      const { count } = await tx.agentTask.updateMany({
        where: { id: taskId, status: 'delivered' },
        data: { status: body.status },
      });
      if (!count) throw notFound();
      await tx.agentTaskResult.create({
        data: {
          taskId,
          organizationId: agent.organizationId,
          agentId: agent.id,
          status: body.status,
          result: (body.result ?? undefined) as Prisma.InputJsonValue | undefined,
          error: body.error ?? null,
          receivedAt: this.now(),
        },
      });
    });
  }

  list(ctx: TenantContext, agentId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const rows = await tx.agentTask.findMany({
        where: { agentId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { result: true },
      });
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        payload: r.payload,
        expiresAt: r.expiresAt,
        deliveredAt: r.deliveredAt,
        createdAt: r.createdAt,
        result: r.result?.result ?? null,
        error: r.result?.error ?? null,
        completedAt: r.result?.receivedAt ?? null,
      }));
    });
  }

  /** Opens a stream session for a task (log tail, inspection); used from M10. */
  openStream(ctx: TenantContext, taskId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const task = await tx.agentTask.findUnique({ where: { id: taskId } });
      if (!task) throw notFound();
      return tx.agentStreamSession.create({
        data: {
          organizationId: ctx.organizationId,
          agentId: task.agentId,
          taskId,
          expiresAt: task.expiresAt,
        },
      });
    });
  }

  /** Relays a chunk to subscribers of `stream:<sessionId>` (browser WebSocket relay arrives in M10). */
  async chunk(ctx: TenantContext, agent: AgentIdentity, sessionId: string, body: unknown): Promise<void> {
    const check = validateMessage('stream-chunk', body);
    if (!check.ok)
      throw new ApiException(400, 'invalid_request', `Invalid chunk: ${check.errors.join('; ')}`);
    if ((body as { sessionId: string }).sessionId !== sessionId) throw notFound();
    const session = await withTenant(this.prisma, ctx, (tx) =>
      tx.agentStreamSession.findFirst({
        where: { id: sessionId, agentId: agent.id, status: 'open', expiresAt: { gt: this.now() } },
      }),
    );
    if (!session) throw notFound();
    await this.redis.publish(`stream:${sessionId}`, JSON.stringify(body));
  }
}
