import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { validateMessage } from '@pcp/agent-protocol';
import { AgentRoute } from '../../common/decorators.js';
import { ApiException, parseBody } from '../../common/errors.js';
import { requireAgent, type ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { DiscoveryService } from '../discovery/discovery.service.js';
import { PacksService } from './packs.service.js';
import { configAckBody } from './schemas.js';

@Controller('agent/v1')
export class AgentConfigController {
  constructor(
    private readonly packs: PacksService,
    private readonly discovery: DiscoveryService,
  ) {}

  /** Discovery snapshot: replaces the previous one (start-up and every 5 minutes). */
  @AgentRoute()
  @Post('inventory')
  @HttpCode(202)
  async inventory(@Req() req: ApiRequest, @Body() body: unknown) {
    const check = validateMessage('inventory', body);
    if (!check.ok)
      throw new ApiException(400, 'invalid_request', `Invalid inventory: ${check.errors.join('; ')}`);
    const agent = requireAgent(req);
    await this.packs.saveInventory(requireTenant(req), agent, body as never);
    // New services on a host refresh the product's graph (debounced).
    this.discovery.trigger(requireTenant(req), agent.productId);
    return { accepted: true };
  }

  /** Fetched when the heartbeat answers with a policy version the agent has not applied. */
  @AgentRoute()
  @Get('config')
  config(@Req() req: ApiRequest) {
    return this.packs.config(requireTenant(req), requireAgent(req));
  }

  @AgentRoute()
  @Post('config/ack')
  @HttpCode(204)
  async ack(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.packs.ack(requireTenant(req), requireAgent(req), parseBody(configAckBody, body));
  }
}
