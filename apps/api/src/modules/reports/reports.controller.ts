import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { ReportsService } from './reports.service.js';

const SCHEDULE = { param: 'id', resource: 'report_schedule' } as const;
const REPORT = { param: 'id', resource: 'report' } as const;

const fields = {
  name: z.string().trim().min(1).max(100),
  timezone: z.string().min(1).max(64),
  localTime: z.string().min(1).max(5),
  channelIds: z.array(z.string().uuid()).max(20),
  recipients: z.array(z.string().trim().max(254)).max(50),
  environmentId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
};
const createBody = z.object({ productId: z.string().uuid(), ...fields }).strict();
const updateBody = z.object(fields).partial().strict();

@Controller('api/v1')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermission('report.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/report-schedules/preview')
  preview(@Query('timezone') timezone = '', @Query('localTime') localTime = '') {
    return this.reports.preview(timezone, localTime);
  }

  @RequirePermission('report.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/report-schedules')
  list(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.reports.list(requireTenant(req), productId);
  }

  /** WB-15 §7: the product travels in the body; the tenant guard resolves it before this runs. */
  @RequirePermission('report.manage')
  @TenantScope({ body: 'productId' })
  @Post('report-schedules')
  @HttpCode(201)
  create(@Req() req: ApiRequest, @Body() body: unknown) {
    const { productId, ...input } = parseBody(createBody, body);
    return this.reports.create(requireTenant(req), productId, input);
  }

  @RequirePermission('report.manage')
  @TenantScope(SCHEDULE)
  @Patch('report-schedules/:id')
  update(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.reports.update(requireTenant(req), id, parseBody(updateBody, body));
  }

  @RequirePermission('report.manage')
  @TenantScope(SCHEDULE)
  @Delete('report-schedules/:id')
  @HttpCode(204)
  async remove(@Req() req: ApiRequest, @Param('id') id: string) {
    await this.reports.remove(requireTenant(req), id);
  }

  @RequirePermission('report.manage')
  @TenantScope(SCHEDULE)
  @Post('report-schedules/:id/run')
  @HttpCode(202)
  run(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.reports.run(requireTenant(req), id);
  }

  @RequirePermission('report.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/reports')
  history(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.reports.reports(requireTenant(req), productId);
  }

  @RequirePermission('report.view')
  @TenantScope(REPORT)
  @Get('reports/:id')
  report(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.reports.report(requireTenant(req), id);
  }

  @RequirePermission('report.manage')
  @TenantScope(REPORT)
  @Post('reports/:id/regenerate')
  @HttpCode(202)
  regenerate(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.reports.regenerate(requireTenant(req), id);
  }
}
