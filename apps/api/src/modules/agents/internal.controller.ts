import { Controller, Get, Inject, Param } from '@nestjs/common';
import { Internal } from '../../common/decorators.js';
import { notFound } from '../../common/errors.js';
import { CLOCK } from '../../tokens.js';
import { AgentIdentityCache } from './agent-identity.cache.js';

const FINGERPRINT = /^[0-9a-f]{64}$/;

@Controller('internal/agents')
export class InternalAgentsController {
  constructor(
    private readonly cache: AgentIdentityCache,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  /** Agent identity for the ingest gateway (D15); same validity rules as the control channel. */
  @Internal()
  @Get('by-fingerprint/:fp')
  async byFingerprint(@Param('fp') fp: string) {
    if (!FINGERPRINT.test(fp)) throw notFound();
    const state = await this.cache.get(fp);
    if (!state || !AgentIdentityCache.valid(state, this.now())) throw notFound();
    return {
      agentId: state.agent_id,
      organizationId: state.organization_id,
      productId: state.product_id,
      environmentId: state.environment_id,
    };
  }
}
