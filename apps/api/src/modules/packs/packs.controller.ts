import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission, SessionOnly, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { AGENT } from '../agents/agents.controller.js';
import { PACKS } from './catalog.js';
import { LiveBoostService } from './live-boost.service.js';
import { PacksService } from './packs.service.js';
import { z } from 'zod';
import { enablePackBody } from './schemas.js';

const boostBody = z.object({ packId: z.string().min(1).max(40) }).strict();

@Controller('api/v1')
export class PacksController {
  constructor(
    private readonly packs: PacksService,
    private readonly boosts: LiveBoostService,
  ) {}

  @SessionOnly()
  @Get('monitoring-packs')
  catalog() {
    return {
      packs: PACKS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        defaultEndpoint: p.defaultEndpoint,
        credentialFields: p.credentialFields,
        ...(p.guide ? { guide: p.guide } : {}),
        settings: p.settingsSchema,
      })),
    };
  }

  @RequirePermission('agent.view')
  @TenantScope(AGENT)
  @Get('agents/:id/inventory')
  inventory(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.packs.inventory(requireTenant(req), id);
  }

  @RequirePermission('agent.view')
  @TenantScope(AGENT)
  @Get('agents/:id/packs')
  async list(@Req() req: ApiRequest, @Param('id') id: string) {
    return { packs: await this.packs.list(requireTenant(req), id) };
  }

  @RequirePermission('pack.manage')
  @TenantScope(AGENT)
  @Post('agents/:id/packs')
  async enable(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { created, assignment } = await this.packs.enable(
      requireTenant(req),
      id,
      parseBody(enablePackBody, body),
    );
    reply.status(created ? 201 : 200);
    return assignment;
  }

  @RequirePermission('pack.manage')
  @TenantScope(AGENT)
  @Delete('agents/:id/packs/:packId')
  @HttpCode(202)
  disable(@Req() req: ApiRequest, @Param('id') id: string, @Param('packId') packId: string) {
    return this.packs.disable(requireTenant(req), id, packId);
  }

  /** Live boost (M10.7): one pack at 5 s for 10 minutes; the agent reverts on its own. */
  @RequirePermission('telemetry.query')
  @TenantScope(AGENT)
  @Post('agents/:id/live-boost')
  @HttpCode(202)
  startBoost(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.boosts.start(requireTenant(req), id, parseBody(boostBody, body).packId);
  }

  @RequirePermission('telemetry.query')
  @TenantScope(AGENT)
  @Get('agents/:id/live-boost')
  async boostsFor(@Req() req: ApiRequest, @Param('id') id: string) {
    return { boosts: await this.boosts.active(requireTenant(req), id) };
  }
}
