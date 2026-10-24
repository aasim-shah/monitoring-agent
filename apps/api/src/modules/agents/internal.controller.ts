import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import { withTenant } from '@pcp/tenant-security';
import { Internal } from '../../common/decorators.js';
import { notFound } from '../../common/errors.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { AgentIdentityCache } from './agent-identity.cache.js';

const FINGERPRINT = /^[0-9a-f]{64}$/;

@Controller('internal/agents')
export class InternalAgentsController {
  constructor(
    private readonly cache: AgentIdentityCache,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  /** Agent identity for the ingest gateway (D15); same validity rules as the control channel. */
  @Internal()
  @Get('by-fingerprint/:fp')
  async byFingerprint(@Param('fp') fp: string) {
    if (!FINGERPRINT.test(fp)) throw notFound();
    const state = await this.cache.get(fp);
    if (!state || !AgentIdentityCache.valid(state, this.now())) throw notFound();
    // The tenant's VictoriaLogs AccountID: the gateway stamps it on retained logs (M18.1).
    const org = await withTenant(
      this.prisma,
      {
        organizationId: state.organization_id,
        actor: { kind: 'system', jobId: 'ingest-gateway' },
        roles: ['owner'],
        productIds: 'all',
        environmentIds: 'all',
        requestId: 'ingest-gateway',
      },
      (tx) =>
        tx.organization.findUnique({ where: { id: state.organization_id }, select: { logsAccountId: true } }),
    );
    return {
      agentId: state.agent_id,
      organizationId: state.organization_id,
      productId: state.product_id,
      environmentId: state.environment_id,
      logsAccountId: org?.logsAccountId ?? 0,
    };
  }
}
