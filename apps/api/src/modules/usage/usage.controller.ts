import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Internal, RequirePermission, TenantScope } from '../../common/decorators.js';
import { ApiException, parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { USAGE_RANGES, UsageService, type UsageRange } from './usage.service.js';

const count = z.number().int().min(0).max(1e12);
const reportBody = z
  .object({
    tenants: z
      .array(
        z.object({
          organizationId: z.string().uuid(),
          activeSeries: count,
          samples: count,
          refusedSeriesRequests: count,
          refusedRateRequests: count,
        }),
      )
      .max(10_000),
  })
  .strict();

/** The ingest gateway's per-minute report (X-Internal-Token; Caddy never routes /internal). */
@Controller('internal/v1')
export class InternalUsageController {
  constructor(private readonly usage: UsageService) {}

  @Internal()
  @Post('telemetry-usage')
  @HttpCode(204)
  async report(@Body() body: unknown) {
    await this.usage.record(parseBody(reportBody, body).tenants);
  }
}

@Controller('api/v1/organizations')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @RequirePermission('org.view')
  @TenantScope({ param: 'orgId' })
  @Get(':orgId/usage')
  async get(@Req() req: ApiRequest, @Param('orgId') _orgId: string, @Query('range') range = '24h') {
    if (!(range in USAGE_RANGES))
      throw new ApiException(
        400,
        'invalid_range',
        `range must be one of ${Object.keys(USAGE_RANGES).join(', ')}`,
      );
    return this.usage.view(requireTenant(req), range as UsageRange);
  }
}
