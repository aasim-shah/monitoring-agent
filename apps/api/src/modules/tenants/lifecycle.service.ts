import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createQueues, enqueue, type Queues } from '@pcp/jobs';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException, notFound } from '../../common/errors.js';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG, CLOCK, PRISMA } from '../../tokens.js';
import { AgentsService } from '../agents/agents.service.js';
import { AuditService } from '../auditing/audit.service.js';

/** Days an organization stays recoverable after its owner asks to delete it (WB-17 UC-17-09). */
export const DELETION_GRACE_DAYS = 30;

/**
 * Organization deletion with a grace period: members lose access at once, agents are revoked and
 * connections disconnected (their secrets crypto-shredded); the owner can cancel until the purge.
 */
@Injectable()
export class LifecycleService implements OnApplicationShutdown {
  private readonly queues: Queues;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly agents: AgentsService,
    private readonly audit: AuditService,
  ) {
    this.queues = createQueues(config.redisUrl);
  }

  async onApplicationShutdown() {
    await this.queues.close();
  }

  /** Queues an export (one at a time); the worker writes the archive (WB-17 UC-17-09). */
  async requestExport(ctx: TenantContext) {
    const exp = await withTenant(this.prisma, ctx, async (tx) => {
      const queued = await tx.tenantExport.findFirst({ where: { status: 'queued' } });
      if (queued) return queued;
      const created = await tx.tenantExport.create({
        data: {
          organizationId: ctx.organizationId,
          requestedByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
          status: 'queued',
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'organization.export_requested',
        targetType: 'tenant_export',
        targetId: created.id,
      });
      return created;
    });
    await enqueue(this.queues, 'tenant-export', {
      organizationId: ctx.organizationId,
      connectionId: exp.id,
      requestId: ctx.requestId,
    });
    return exp;
  }

  listExports(ctx: TenantContext) {
    return withTenant(this.prisma, ctx, (tx) =>
      tx.tenantExport.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, status: true, sizeBytes: true, error: true, expiresAt: true, createdAt: true },
      }),
    );
  }

  /** The archive while its link is valid: 409 until ready, 410 once expired. */
  async exportArchive(ctx: TenantContext, id: string) {
    const exp = await withTenant(this.prisma, ctx, (tx) => tx.tenantExport.findUnique({ where: { id } }));
    if (!exp) throw notFound();
    if (exp.status === 'queued')
      throw new ApiException(409, 'export_not_ready', 'The export is still being built');
    if (exp.status !== 'ready' || !exp.archive || !exp.expiresAt || exp.expiresAt <= this.now())
      throw new ApiException(410, 'export_expired', 'This export link has expired; request a new export');
    await withTenant(this.prisma, ctx, (tx) =>
      this.audit.record(tx, ctx, {
        action: 'organization.export_downloaded',
        targetType: 'tenant_export',
        targetId: id,
      }),
    );
    return { archive: Buffer.from(exp.archive), createdAt: exp.createdAt };
  }

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
