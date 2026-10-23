import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { AGENT } from '../agents/agents.controller.js';
import { TailService } from './tail.service.js';

@Controller('api/v1')
export class LogsController {
  constructor(private readonly tail: TailService) {}

  @RequirePermission('agent.view')
  @TenantScope(AGENT)
  @Get('agents/:id/log-sources')
  async sources(@Req() req: ApiRequest, @Param('id') id: string) {
    return { sources: await this.tail.sources(requireTenant(req), id) };
  }

  /** Server-sent events: `ready`, `lines`, then `end` or `error` (WB-12 UC-12-01). */
  @RequirePermission('logs.tail')
  @TenantScope(AGENT)
  @Get('agents/:id/logs/tail')
  async liveTail(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Query('source') source: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    await this.tail.stream(requireTenant(req), id, source ?? '', reply);
  }
}
