import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException, notFound } from '../../common/errors.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { TasksService } from '../agents/tasks.service.js';
import { atLeast } from '../logs/agent-version.js';

/** Live boost (M10.7, BR-11-08): 5 s collection for 10 minutes, at most 3 per tenant. */
export const BOOST_SECONDS = 600;
export const BOOST_INTERVAL_SECONDS = 5;
export const MAX_ACTIVE_BOOSTS = 3;
export const MINIMUM_BOOST_AGENT_VERSION = '0.4.0';

@Injectable()
export class LiveBoostService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly tasks: TasksService,
  ) {}

  active(ctx: TenantContext, agentId: string) {
    return withTenant(this.prisma, ctx, (tx) =>
      tx.agentLiveBoost.findMany({
        where: { agentId, expiresAt: { gt: this.now() } },
        orderBy: { expiresAt: 'asc' },
        select: { packId: true, expiresAt: true },
      }),
    );
  }

  async start(ctx: TenantContext, agentId: string, packId: string) {
    const now = this.now();
    // Whole seconds: the agent receives the deadline as epoch seconds.
    const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + BOOST_SECONDS * 1000);
    const created = await withTenant(this.prisma, ctx, async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id: agentId } });
      if (!agent) throw notFound();
      if (!atLeast(agent.agentVersion, MINIMUM_BOOST_AGENT_VERSION))
        throw new ApiException(
          409,
          'agent_upgrade_required',
          `Live boost needs agent ${MINIMUM_BOOST_AGENT_VERSION} or later; ${agent.hostname} runs ${agent.agentVersion}`,
        );
      const pack = await tx.agentPackAssignment.findFirst({ where: { agentId, packId } });
      if (!pack) throw new ApiException(400, 'pack_not_enabled', `${packId} is not enabled on this host`);
      const existing = await tx.agentLiveBoost.findFirst({
        where: { agentId, packId, expiresAt: { gt: now } },
      });
      if (existing) return { boost: existing, fresh: false };
      // Serialize boosts per tenant so two requests cannot both take the third slot.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'live-boost:' + ctx.organizationId}))`;
      const active = await tx.agentLiveBoost.count({ where: { expiresAt: { gt: now } } });
      if (active >= MAX_ACTIVE_BOOSTS)
        throw new ApiException(
          409,
          'boost_limit',
          `At most ${MAX_ACTIVE_BOOSTS} live boosts can run at once`,
        );
      const boost = await tx.agentLiveBoost.create({
        data: {
          organizationId: ctx.organizationId,
          agentId,
          packId,
          expiresAt,
          createdByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
        },
      });
      return { boost, fresh: true };
    });
    if (created.fresh) {
      const task = await this.tasks.create(ctx, agentId, {
        type: 'live_boost',
        payload: {
          packId,
          intervalSeconds: BOOST_INTERVAL_SECONDS,
          untilEpoch: Math.floor(expiresAt.getTime() / 1000),
        },
        resourceScope: { agentId, packId },
        ttlSeconds: BOOST_SECONDS,
        maxRuntimeSeconds: 30,
        maxResponseBytes: 4096,
      });
      await withTenant(this.prisma, ctx, (tx) =>
        tx.agentLiveBoost.update({ where: { id: created.boost.id }, data: { taskId: task.id } }),
      );
    }
    return { packId, expiresAt: created.boost.expiresAt };
  }
}
