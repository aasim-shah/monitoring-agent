import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { AppConfig } from '../../config.js';
import { notFound } from '../../common/errors.js';
import { APP_CONFIG, CLOCK, PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import { AGENT_SETTINGS, requireSettings, type AgentSettings } from './settings.provider.js';
import { EnrollmentTokens } from './tokens.js';

/** Admin side of enrollment (UC-03-01): issue and list enrollment tokens for an environment. */
@Injectable()
export class EnrollmentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AGENT_SETTINGS) private readonly settings: AgentSettings | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly tokens: EnrollmentTokens,
    private readonly audit: AuditService,
  ) {}

  async create(
    ctx: TenantContext,
    environmentId: string,
    input: { agentType: 'host' | 'private_worker'; maxUses: number; expiresInMinutes: number },
  ) {
    const settings = requireSettings(this.settings);
    const token = this.tokens.generate();
    const expiresAt = new Date(this.now().getTime() + input.expiresInMinutes * 60_000);
    const enrollment = await withTenant(this.prisma, ctx, async (tx) => {
      const env = await tx.environment.findUnique({
        where: { id: environmentId },
        select: { productId: true },
      });
      if (!env) throw notFound();
      const row = await tx.agentEnrollment.create({
        data: {
          organizationId: ctx.organizationId,
          productId: env.productId,
          environmentId,
          agentType: input.agentType,
          tokenHash: this.tokens.hash(token),
          expiresAt,
          maxUses: input.maxUses,
          createdByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'agent_enrollment.created',
        targetType: 'agent_enrollment',
        targetId: row.id,
        metadata: { environmentId, maxUses: input.maxUses, expiresAt: expiresAt.toISOString() },
      });
      return row;
    });
    return {
      id: enrollment.id,
      token,
      expiresAt: enrollment.expiresAt,
      maxUses: enrollment.maxUses,
      installCommand: `curl -fsSL ${this.config.appOrigin}/install.sh | sudo bash -s -- --token ${token} --control-url ${settings.config.controlUrl}`,
    };
  }

  list(ctx: TenantContext, environmentId: string) {
    return withTenant(this.prisma, ctx, (tx) =>
      tx.agentEnrollment.findMany({
        where: { environmentId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          agentType: true,
          expiresAt: true,
          maxUses: true,
          uses: true,
          revokedAt: true,
          createdAt: true,
        },
      }),
    );
  }
}
