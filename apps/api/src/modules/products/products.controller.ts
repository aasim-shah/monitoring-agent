import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { ProductsService } from './products.service.js';
import { createEnvironmentBody, createProductBody } from './schemas.js';

const environmentView = (e: { id: string; name: string; createdAt: Date }) => ({
  id: e.id,
  name: e.name,
  createdAt: e.createdAt,
});

@Controller('api/v1')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @RequirePermission('product.manage')
  @TenantScope({ param: 'orgId' })
  @Post('organizations/:orgId/products')
  @HttpCode(201)
  async create(@Req() req: ApiRequest, @Body() body: unknown) {
    const p = await this.products.create(requireTenant(req), parseBody(createProductBody, body));
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      domains: p.domains,
      repositories: p.repositories,
    };
  }

  @RequirePermission('product.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId')
  async get(@Req() req: ApiRequest, @Param('productId') productId: string) {
    const p = await this.products.get(requireTenant(req), productId);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      domains: p.domains,
      repositories: p.repositories,
      environments: p.environments.map(environmentView),
    };
  }

  @RequirePermission('product.manage')
  @TenantScope({ param: 'productId' })
  @Post('products/:productId/environments')
  @HttpCode(201)
  async createEnvironment(
    @Req() req: ApiRequest,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ) {
    const { name } = parseBody(createEnvironmentBody, body);
    return environmentView(await this.products.createEnvironment(requireTenant(req), productId, name));
  }

  @RequirePermission('product.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/overview')
  async overview(@Req() req: ApiRequest, @Param('productId') productId: string) {
    const p = await this.products.get(requireTenant(req), productId);
    return {
      product: { id: p.id, name: p.name, domains: p.domains, repositories: p.repositories },
      environments: p.environments.map(environmentView),
      counts: { environments: p.environments.length },
    };
  }
}
