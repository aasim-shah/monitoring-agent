import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { AGENT } from '../agents/agents.controller.js';
import { InspectionsService } from './inspections.service.js';

/** An exact Redis key or Kafka topic: no globs, spaces, or control characters (Review Focus #1). */
const exactName = z.string().regex(/^[A-Za-z0-9._:/@-]{1,200}$/, 'use exact names, no patterns');
const settingsBody = z
  .object({
    enabled: z.boolean().optional(),
    redisKeys: z.array(exactName).max(50).optional(),
    peekTopics: z.array(exactName).max(50).optional(),
  })
  .strict();
const requestBody = z
  .object({
    packId: z.string().min(1).max(40),
    target: z.enum(['redis', 'kafka', 'kafka_peek']),
    topic: exactName.optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

@Controller('api/v1')
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  /** Owner and admin only (`data.inspect.configure`); audited (BR-12-06). */
  @RequirePermission('data.inspect.configure')
  @TenantScope(AGENT)
  @Patch('agents/:id/packs/:packId/inspection')
  configure(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Param('packId') packId: string,
    @Body() body: unknown,
  ) {
    return this.inspections.configure(requireTenant(req), id, packId, parseBody(settingsBody, body));
  }

  @RequirePermission('data.inspect')
  @TenantScope(AGENT)
  @Post('agents/:id/inspections')
  @HttpCode(202)
  request(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.inspections.request(requireTenant(req), id, parseBody(requestBody, body));
  }

  @RequirePermission('data.inspect')
  @TenantScope({ param: 'id', resource: 'inspection_request' })
  @Get('inspections/:id')
  get(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.inspections.get(requireTenant(req), id);
  }
}
