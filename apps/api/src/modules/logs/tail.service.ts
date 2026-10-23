import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { ApiException, notFound } from '../../common/errors.js';
import { CLOCK, PRISMA, REDIS } from '../../tokens.js';
import { TasksService } from '../agents/tasks.service.js';
import { logSources, type LogSource } from './sources.js';
import { SseWriter } from './sse-writer.js';
import { StreamRelay } from './stream-relay.js';
import { MAX_TAILS_PER_AGENT, MAX_TAILS_PER_TENANT, TailLimits } from './tail-limits.js';

export const TAIL_TTL_SECONDS = 15 * 60;
const HEARTBEAT_MS = 15_000;

/** What the agent publishes on `stream:<session>`: its chunks, or the task result (from onResult). */
type StreamMessage =
  | { type?: undefined; sequence: number; lines: string[]; final: boolean }
  | { type: 'result'; status: 'succeeded' | 'failed'; error?: string };

/** Live log tail (spec §11.8, WB-12): signed task, stream session, SSE relay, nothing stored. */
@Injectable()
export class TailService implements OnModuleInit, OnApplicationShutdown {
  private readonly relay: StreamRelay;
  private readonly limits: TailLimits;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly tasks: TasksService,
  ) {
    this.relay = new StreamRelay(redis.duplicate());
    this.limits = new TailLimits(redis);
  }

  onModuleInit() {
    // A refused or finished tail reaches the viewer even when the agent sent no final chunk.
    this.tasks.onResult(async (_ctx, _agent, task, body) => {
      if (task.type !== 'log_tail' || typeof task.payload.sessionId !== 'string') return;
      const message: StreamMessage = { type: 'result', status: body.status, error: body.error };
      await this.redis.publish(`stream:${task.payload.sessionId}`, JSON.stringify(message));
    });
  }

  onApplicationShutdown() {
    this.relay.close();
  }

  async sources(ctx: TenantContext, agentId: string): Promise<LogSource[]> {
    const packs = await withTenant(this.prisma, ctx, async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { id: true } });
      if (!agent) throw notFound();
      return tx.agentPackAssignment.findMany({
        where: { agentId, status: 'applied' },
        select: { packId: true },
      });
    });
    return logSources(packs.map((p) => p.packId));
  }

  /**
   * Validates and reserves before anything is written to the reply, so refusals are plain JSON
   * errors; then hijacks the reply and streams until the final chunk, the task result, or the
   * viewer disconnecting.
   */
  async stream(ctx: TenantContext, agentId: string, sourceId: string, reply: FastifyReply): Promise<void> {
    const allowed = await this.sources(ctx, agentId);
    if (!allowed.some((s) => s.id === sourceId))
      throw new ApiException(400, 'unknown_source', 'This log source is not enabled on this agent');

    const sessionId = randomUUID();
    const reserved = await this.limits.reserve(
      ctx.organizationId,
      agentId,
      sessionId,
      this.now(),
      TAIL_TTL_SECONDS * 1000,
    );
    if (reserved === 'agent_full')
      throw new ApiException(429, 'too_many_streams', `At most ${MAX_TAILS_PER_AGENT} live tails per agent`);
    if (reserved === 'tenant_full')
      throw new ApiException(
        429,
        'too_many_streams',
        `At most ${MAX_TAILS_PER_TENANT} live tails per organization`,
      );

    const out = new SseWriter(reply.raw);
    let finished = false;
    const timers: { heartbeat?: NodeJS.Timeout; expiry?: NodeJS.Timeout } = {};
    let unlisten: (() => Promise<void>) | undefined;
    const finish = async (last?: { event: string; data: unknown }) => {
      if (finished) return;
      finished = true;
      clearInterval(timers.heartbeat);
      clearTimeout(timers.expiry);
      out.close(last);
      await unlisten?.();
      await this.tasks.closeStream(ctx, sessionId).catch(() => {});
      await this.limits.release(ctx.organizationId, agentId, sessionId).catch(() => {});
    };

    try {
      unlisten = await this.relay.listen(sessionId, (message) => {
        const m = JSON.parse(message) as StreamMessage;
        if (m.type === 'result') {
          void finish(
            m.status === 'failed'
              ? { event: 'error', data: { message: m.error ?? 'Log tail failed' } }
              : { event: 'end', data: {} },
          );
          return;
        }
        if (m.lines.length) out.event('lines', { sequence: m.sequence, lines: m.lines });
        if (m.final) void finish({ event: 'end', data: {} });
      });
      await this.tasks.create(ctx, agentId, {
        type: 'log_tail',
        payload: { source: sourceId, sessionId },
        resourceScope: { agentId },
        ttlSeconds: TAIL_TTL_SECONDS,
        maxRuntimeSeconds: TAIL_TTL_SECONDS,
        streamSessionId: sessionId,
      });
    } catch (err) {
      finished = true;
      await unlisten?.();
      await this.limits.release(ctx.organizationId, agentId, sessionId).catch(() => {});
      throw err;
    }

    reply.hijack();
    // `ready` goes first; anything the agent already sent was queued behind it.
    out.open(
      {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // nginx and other proxies must not buffer the stream.
        'x-accel-buffering': 'no',
      },
      () => void finish(),
      { event: 'ready', data: { sessionId, source: sourceId } },
    );
    timers.heartbeat = setInterval(() => out.comment('heartbeat'), HEARTBEAT_MS);
    // The session expires with the task; end the stream then even if the agent never ran it.
    timers.expiry = setTimeout(
      () => void finish({ event: 'end', data: { reason: 'expired' } }),
      TAIL_TTL_SECONDS * 1000,
    );
  }
}
