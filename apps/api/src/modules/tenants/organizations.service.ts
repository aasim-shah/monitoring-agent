import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Organization, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';

type Settings = { dataRetentionDays?: number };

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /** Creates the organization and its first owner in one tenant-scoped transaction. */
  async create(
    userId: string,
    requestId: string,
    input: { name: string; timezone: string },
  ): Promise<Organization> {
    const ctx: TenantContext = {
      organizationId: randomUUID(),
      actor: { kind: 'user', userId },
      roles: ['owner'],
      productIds: 'all',
      environmentIds: 'all',
      requestId,
    };
    return withTenant(this.prisma, ctx, async (tx) => {
      const org = await tx.organization.create({ data: { id: ctx.organizationId, ...input } });
      const member = await tx.organizationMember.create({
        data: { organizationId: org.id, userId, role: 'owner' },
      });
      await this.audit.record(tx, ctx, {
        action: 'organization.created',
        targetType: 'organization',
        targetId: org.id,
      });
      await this.audit.record(tx, ctx, {
        action: 'member.owner_created',
        targetType: 'member',
        targetId: member.id,
        metadata: { userId },
      });
      return org;
    });
  }

  get(ctx: TenantContext): Promise<Organization> {
    return withTenant(this.prisma, ctx, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }),
    );
  }

  updateSettings(
    ctx: TenantContext,
    input: { name?: string; timezone?: string; settings?: Settings },
  ): Promise<Organization> {
    return withTenant(this.prisma, ctx, async (tx) => {
      const current = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
      const updated = await tx.organization.update({
        where: { id: ctx.organizationId },
        data: {
          name: input.name,
          timezone: input.timezone,
          settings: input.settings ? { ...(current.settings as Settings), ...input.settings } : undefined,
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'organization.settings_updated',
        targetType: 'organization',
        targetId: ctx.organizationId,
        metadata: { fields: Object.keys(input) },
      });
      return updated;
    });
  }
}
