import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { DiscoveryService } from './discovery.service.js';

@Controller('api/v1')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  /** Runs discovery for a product now (hosts, services, databases, websites, correlation rules). */
  @RequirePermission('product.manage')
  @TenantScope({ param: 'productId' })
  @Post('products/:productId/discovery/run')
  @HttpCode(200)
  run(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.discovery.run(requireTenant(req), productId);
  }
}
