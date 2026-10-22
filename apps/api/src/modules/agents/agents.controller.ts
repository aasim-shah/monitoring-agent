import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { AgentsService } from './agents.service.js';

export const AGENT = { param: 'id', resource: 'agent' } as const;

@Controller('api/v1')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @RequirePermission('agent.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/agents')
  async list(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return { agents: await this.agents.list(requireTenant(req), productId) };
  }

  @RequirePermission('agent.view')
  @TenantScope(AGENT)
  @Get('agents/:id')
  get(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.agents.get(requireTenant(req), id);
  }

  @RequirePermission('agent.revoke')
  @TenantScope(AGENT)
  @Post('agents/:id/revoke')
  @HttpCode(200)
  revoke(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.agents.revoke(requireTenant(req), id);
  }
}
