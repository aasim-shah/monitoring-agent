import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Organization, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { PRISMA } from '../../tokens.js';

type Settings = { dataRetentionDays?: number };

@Injectable()
export class OrganizationsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

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
      await tx.organizationMember.create({ data: { organizationId: org.id, userId, role: 'owner' } });
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
      return tx.organization.update({
        where: { id: ctx.organizationId },
        data: {
          name: input.name,
          timezone: input.timezone,
          settings: input.settings ? { ...(current.settings as Settings), ...input.settings } : undefined,
        },
      });
    });
  }
}
