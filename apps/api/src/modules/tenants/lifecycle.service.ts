import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException, notFound } from '../../common/errors.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { AgentsService } from '../agents/agents.service.js';
import { AuditService } from '../auditing/audit.service.js';

/** Days an organization stays recoverable after its owner asks to delete it (WB-17 UC-17-09). */
export const DELETION_GRACE_DAYS = 30;

/**
 * Organization deletion with a grace period: members lose access at once, agents are revoked and
 * connections disconnected (their secrets crypto-shredded); the owner can cancel until the purge.
 */
@Injectable()
export class LifecycleService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly agents: AgentsService,
    private readonly audit: AuditService,
  ) {}

  async requestDeletion(ctx: TenantContext, confirmName: string) {
    const org = await withTenant(this.prisma, ctx, (tx) =>
      tx.organization.findUnique({ where: { id: ctx.organizationId } }),
    );
    if (!org) throw notFound();
    if (confirmName !== org.name)
      throw new ApiException(400, 'confirmation_mismatch', 'Type the organization name exactly to confirm');
    if (org.deletionScheduledFor) return org;

    const requestedAt = this.now();
    const scheduledFor = new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * 86_400_000);
    const agents = await withTenant(this.prisma, ctx, async (tx) => {
      await tx.organization.update({
        where: { id: ctx.organizationId },
        data: {
          deletionRequestedAt: requestedAt,
          deletionScheduledFor: scheduledFor,
          deletionRequestedByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
        },
      });
      // Connections: secrets crypto-shredded, schedules stopped (as a connection delete does).
      await tx.connectionSecret.deleteMany({});
      await tx.connection.updateMany({
        where: { status: { notIn: ['disconnected', 'revoked'] } },
        data: { status: 'disconnected', statusReason: 'organization_deletion' },
      });
      await tx.jobDefinition.updateMany({ data: { enabled: false } });
      await this.audit.record(tx, ctx, {
        action: 'organization.deletion_requested',
        targetType: 'organization',
        targetId: ctx.organizationId,
        metadata: { scheduledFor: scheduledFor.toISOString() },
      });
      return tx.agent.findMany({ where: { status: { not: 'revoked' } }, select: { id: true } });
    });
    // Agents through the usual revoke path, so the ingest gateway refuses their certificates too.
    for (const a of agents) await this.agents.revoke(ctx, a.id);
    return { ...org, deletionRequestedAt: requestedAt, deletionScheduledFor: scheduledFor };
  }

  async cancelDeletion(ctx: TenantContext) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const org = await tx.organization.update({
        where: { id: ctx.organizationId },
        data: { deletionRequestedAt: null, deletionScheduledFor: null, deletionRequestedByUserId: null },
      });
      await this.audit.record(tx, ctx, {
        action: 'organization.deletion_cancelled',
        targetType: 'organization',
        targetId: ctx.organizationId,
      });
      return org;
    });
  }
}
