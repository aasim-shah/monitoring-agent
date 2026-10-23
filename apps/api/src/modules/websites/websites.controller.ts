import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { MIN_INTERVAL_SECONDS, WebsitesService } from './websites.service.js';

const MONITOR = { param: 'id', resource: 'website_monitor' } as const;
const createBody = z
  .object({
    url: z.string().trim().max(2048),
    intervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(3600).default(60),
    expectedStatus: z.number().int().min(100).max(599).nullable().optional(),
  })
  .strict();

@Controller('api/v1')
export class WebsitesController {
  constructor(private readonly websites: WebsitesService) {}

  @RequirePermission('telemetry.query')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/website-monitors')
  list(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.websites.list(requireTenant(req), productId);
  }

  @RequirePermission('pack.manage')
  @TenantScope({ param: 'productId' })
  @Post('products/:productId/website-monitors')
  @HttpCode(201)
  create(@Req() req: ApiRequest, @Param('productId') productId: string, @Body() body: unknown) {
    return this.websites.create(requireTenant(req), productId, parseBody(createBody, body));
  }

  @RequirePermission('pack.manage')
  @TenantScope(MONITOR)
  @Post('website-monitors/:id/verify')
  @HttpCode(200)
  verify(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.websites.verify(requireTenant(req), id);
  }

  @RequirePermission('pack.manage')
  @TenantScope(MONITOR)
  @Delete('website-monitors/:id')
  @HttpCode(204)
  async remove(@Req() req: ApiRequest, @Param('id') id: string) {
    await this.websites.remove(requireTenant(req), id);
  }
}
