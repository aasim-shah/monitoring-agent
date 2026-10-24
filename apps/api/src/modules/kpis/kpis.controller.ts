import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { ApiException } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { KPI_RANGES, KpisService, type KpiRange } from './kpis.service.js';

@Controller('api/v1')
export class KpisController {
  constructor(private readonly kpis: KpisService) {}

  /** Analytics, search, and mobile KPIs with freshness (WB-09 UC-09-06). */
  @RequirePermission('telemetry.query')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/kpis')
  get(@Req() req: ApiRequest, @Param('productId') productId: string, @Query('range') range = '28d') {
    if (!(range in KPI_RANGES))
      throw new ApiException(
        400,
        'invalid_range',
        `range must be one of ${Object.keys(KPI_RANGES).join(', ')}`,
      );
    return this.kpis.forProduct(requireTenant(req), productId, range as KpiRange);
  }
}
