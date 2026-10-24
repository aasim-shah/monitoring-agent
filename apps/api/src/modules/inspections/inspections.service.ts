import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { Redis } from 'ioredis';
import { ApiException, notFound } from '../../common/errors.js';
import { CLOCK, PRISMA, REDIS } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import { TasksService } from '../agents/tasks.service.js';
import { atLeast } from '../logs/agent-version.js';

export const MINIMUM_INSPECTION_AGENT_VERSION = '0.5.0';
/** A peek's messages are kept this long in Redis, never in PostgreSQL (UC-12-08). */
export const PEEK_TTL_SECONDS = 600;
export const PEEK_LIMIT = 20;

export type InspectionTarget = 'redis' | 'kafka' | 'kafka_peek';
const TARGET_PACK: Record<InspectionTarget, string> = { redis: 'redis', kafka: 'kafka', kafka_peek: 'kafka' };

export interface InspectionSettings {
  enabled: boolean;
  redisKeys: string[];
  peekTopics: string[];
}

const peekKey = (id: string) => `inspect:peek:${id}`;

function settingsOf(raw: unknown): InspectionSettings {
  const s = (raw ?? {}) as Partial<InspectionSettings>;
  return { enabled: s.enabled === true, redisKeys: s.redisKeys ?? [], peekTopics: s.peekTopics ?? [] };
}

/**
 * Data inspection (M18.2, spec §11.9): off by default per pack, allowlisted and read-only on the
 * agent, audited. Stats are kept with the request; a peek's messages only in Redis for 10 minutes.
 * AI tools have no access to any of it (BR-12-07).
 */
@Injectable()
export class InspectionsService implements OnModuleInit {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.tasks.onResult(async (ctx, _agent, task, body) => {
      if (task.type !== 'inspect' || task.payload.target === 'agent_info') return;
      await this.complete(ctx, task.id, body);
    });
  }

  async configure(ctx: TenantContext, agentId: string, packId: string, input: Partial<InspectionSettings>) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const pack = await tx.agentPackAssignment.findFirst({ where: { agentId, packId } });
      if (!pack) throw new ApiException(400, 'pack_not_enabled', `${packId} is not enabled on this host`);
      if (packId !== 'redis' && packId !== 'kafka')
        throw new ApiException(
          400,
          'not_inspectable',
          'Only the Redis and Kafka packs support data inspection',
        );
      const current = settingsOf(pack.inspection);
      const next: InspectionSettings = {
        enabled: input.enabled ?? current.enabled,
        redisKeys: packId === 'redis' ? (input.redisKeys ?? current.redisKeys) : [],
        peekTopics: packId === 'kafka' ? (input.peekTopics ?? current.peekTopics) : [],
      };
      await tx.agentPackAssignment.update({
        where: { id: pack.id },
        data: { inspection: next as unknown as Prisma.InputJsonValue },
      });
      await this.audit.record(tx, ctx, {
        action: 'inspection.configured',
        targetType: 'agent',
        targetId: agentId,
        metadata: { packId, ...next },
      });
      return next;
    });
  }

  async request(
    ctx: TenantContext,
    agentId: string,
    input: { packId: string; target: InspectionTarget; topic?: string; reason?: string },
  ) {
    if (TARGET_PACK[input.target] !== input.packId)
      throw new ApiException(
        400,
        'invalid_target',
        `${input.target} does not apply to the ${input.packId} pack`,
      );
    if (input.target === 'kafka_peek' && (!input.topic || !input.reason))
      throw new ApiException(400, 'peek_needs_reason', 'A message peek needs a topic and a reason');
    const { request, settings } = await withTenant(this.prisma, ctx, async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id: agentId } });
      if (!agent) throw notFound();
      if (!atLeast(agent.agentVersion, MINIMUM_INSPECTION_AGENT_VERSION))
        throw new ApiException(
          409,
          'agent_upgrade_required',
          `Data inspection needs agent ${MINIMUM_INSPECTION_AGENT_VERSION} or later; ${agent.hostname} runs ${agent.agentVersion}`,
        );
      const pack = await tx.agentPackAssignment.findFirst({ where: { agentId, packId: input.packId } });
      const settings = settingsOf(pack?.inspection);
      if (!pack || !settings.enabled)
        throw new ApiException(
          409,
          'inspection_disabled',
          'Data inspection is off for this pack; an owner or admin can turn it on',
        );
      if (input.target === 'kafka_peek' && !settings.peekTopics.includes(input.topic!))
        throw new ApiException(
          409,
          'topic_not_allowlisted',
          `Message peek is not allowed for topic ${input.topic}`,
        );
      const request = await tx.inspectionRequest.create({
        data: {
          organizationId: ctx.organizationId,
          agentId,
          packId: input.packId,
          target: input.target,
          topic: input.topic ?? null,
          reason: input.reason ?? null,
          status: 'queued',
          requestedByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'inspection.requested',
        targetType: 'agent',
        targetId: agentId,
        metadata: {
          requestId: request.id,
          packId: input.packId,
          target: input.target,
          topic: input.topic ?? null,
          reason: input.reason ?? null,
        },
      });
      return { request, settings };
    });
    const task = await this.tasks.create(ctx, agentId, {
      type: 'inspect',
      payload: {
        target: input.target,
        packId: input.packId,
        ...(input.target === 'redis' ? { keys: settings.redisKeys } : {}),
        ...(input.target === 'kafka_peek'
          ? { topic: input.topic, allowedTopics: settings.peekTopics, limit: PEEK_LIMIT }
          : {}),
      },
      resourceScope: { agentId, packId: input.packId },
      ttlSeconds: 120,
      maxRuntimeSeconds: 30,
      maxResponseBytes: 262_144,
    });
    await withTenant(this.prisma, ctx, (tx) =>
      tx.inspectionRequest.update({ where: { id: request.id }, data: { taskId: task.id } }),
    );
    return { id: request.id, status: 'queued' };
  }

  async get(ctx: TenantContext, id: string) {
    const r = await withTenant(this.prisma, ctx, (tx) => tx.inspectionRequest.findUnique({ where: { id } }));
    if (!r) throw notFound();
    let result = r.result;
    let expired = false;
    if (r.target === 'kafka_peek' && r.status === 'succeeded') {
      const cached = await this.redis.get(peekKey(r.id));
      result = cached ? (JSON.parse(cached) as Prisma.JsonValue) : null;
      expired = !cached;
    }
    return {
      id: r.id,
      agentId: r.agentId,
      packId: r.packId,
      target: r.target,
      topic: r.topic,
      status: r.status,
      result,
      ...(expired ? { expired: true } : {}),
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  }

  private async complete(
    ctx: TenantContext,
    taskId: string,
    body: { status: string; result?: Record<string, unknown> | null; error?: string | null },
  ) {
    await withTenant(this.prisma, ctx, async (tx) => {
      const r = await tx.inspectionRequest.findFirst({ where: { taskId } });
      if (!r) return;
      const data = (body.result as { inspection?: unknown } | null | undefined)?.inspection ?? null;
      const peek = r.target === 'kafka_peek';
      if (peek && body.status === 'succeeded' && data !== null)
        await this.redis.set(peekKey(r.id), JSON.stringify(data), 'EX', PEEK_TTL_SECONDS);
      await tx.inspectionRequest.update({
        where: { id: r.id },
        data: {
          status: body.status === 'succeeded' ? 'succeeded' : 'failed',
          result: peek || data === null ? undefined : (data as Prisma.InputJsonValue),
          error: body.error ?? null,
          finishedAt: this.now(),
        },
      });
    });
  }
}
