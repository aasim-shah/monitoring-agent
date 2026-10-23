import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import { withTenant } from '@pcp/tenant-security';
import { z } from 'zod';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { ApiException, notFound, parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { RANGES, type RangeKey } from '../telemetry/host-metrics.js';
import { TelemetryQueryService } from '../telemetry/query.service.js';
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
  constructor(
    private readonly websites: WebsitesService,
    private readonly telemetry: TelemetryQueryService,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  /** Response time and uptime of one monitor (fixed PromQL; tenant and product scope added by the query service). */
  @RequirePermission('telemetry.query')
  @TenantScope(MONITOR)
  @Get('website-monitors/:id/metrics')
  async metrics(@Req() req: ApiRequest, @Param('id') id: string, @Query('range') rangeKey = '1h') {
    if (!(rangeKey in RANGES))
      throw new ApiException(400, 'invalid_range', `range must be one of ${Object.keys(RANGES).join(', ')}`);
    const range = RANGES[rangeKey as RangeKey];
    const ctx = requireTenant(req);
    const m = await withTenant(this.prisma, ctx, (tx) =>
      tx.websiteMonitor.findUnique({ where: { id }, select: { productId: true } }),
    );
    if (!m) throw notFound();
    const end = this.now();
    const window = {
      start: new Date(end.getTime() - range.seconds * 1000).toISOString(),
      end: end.toISOString(),
      stepSeconds: range.step,
    };
    const charts = [
      {
        key: 'responseTime',
        title: 'Response time',
        unit: 'ms',
        promql: `1000 * avg(website_response_seconds{monitor_id="${id}"})`,
      },
      {
        key: 'uptime',
        title: 'Uptime',
        unit: 'percent',
        promql: `100 * avg(avg_over_time(website_up{monitor_id="${id}"}[${Math.max(range.step, 120)}s]))`,
      },
    ] as const;
    const results = await Promise.all(
      charts.map((c) =>
        this.telemetry.query(ctx, { promql: c.promql, ...window }, { productId: m.productId }),
      ),
    );
    return {
      range: rangeKey,
      charts: charts.map((c, i) => ({
        key: c.key,
        title: c.title,
        unit: c.unit,
        series: results[i]!.series.map((s) => ({ label: c.title, points: s.points })),
      })),
    };
  }

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
