import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { AssetsService, RELATIONSHIP_TYPES } from './assets.service.js';

const ASSET = { param: 'id', resource: 'asset' } as const;
const RELATIONSHIP = { param: 'id', resource: 'relationship' } as const;
const ALIAS = { param: 'id', resource: 'asset_alias' } as const;

const ASSET_TYPES = [
  'host',
  'service',
  'database',
  'website',
  'domain',
  'repository',
  'worker',
  'external',
] as const;

const manualAssetBody = z
  .object({
    assetType: z.enum(ASSET_TYPES),
    name: z.string().trim().min(1).max(256),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const manualEdgeBody = z
  .object({ targetAssetId: z.string().uuid(), type: z.enum(RELATIONSHIP_TYPES) })
  .strict();
const correctBody = z
  .object({ targetAssetId: z.string().uuid().optional(), type: z.enum(RELATIONSHIP_TYPES).optional() })
  .strict()
  .refine((b) => b.targetAssetId || b.type, 'targetAssetId or type is required');
const resolveBody = z.object({ action: z.enum(['merge', 'keep_separate']) }).strict();

@Controller('api/v1')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @RequirePermission('asset.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/assets')
  async list(
    @Req() req: ApiRequest,
    @Param('productId') productId: string,
    @Query('type') type?: string,
    @Query('lifecycle') lifecycle?: string,
    @Query('source') source?: string,
  ) {
    return { assets: await this.assets.list(requireTenant(req), productId, { type, lifecycle, source }) };
  }

  @RequirePermission('product.manage')
  @TenantScope({ param: 'productId' })
  @Post('products/:productId/assets')
  createAsset(@Req() req: ApiRequest, @Param('productId') productId: string, @Body() body: unknown) {
    return this.assets.createAsset(requireTenant(req), productId, parseBody(manualAssetBody, body));
  }

  @RequirePermission('asset.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/topology')
  topology(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.assets.topology(requireTenant(req), productId);
  }

  @RequirePermission('asset.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/coverage')
  coverage(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.assets.coverage(requireTenant(req), productId);
  }

  @RequirePermission('asset.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/review')
  review(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.assets.review(requireTenant(req), productId);
  }

  @RequirePermission('asset.view')
  @TenantScope(ASSET)
  @Get('assets/:id')
  get(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.assets.get(requireTenant(req), id);
  }

  @RequirePermission('asset.view')
  @TenantScope(ASSET)
  @Get('assets/:id/relationships')
  async relationships(@Req() req: ApiRequest, @Param('id') id: string) {
    return { relationships: await this.assets.relationships(requireTenant(req), id) };
  }

  @RequirePermission('asset.view')
  @TenantScope(ASSET)
  @Get('assets/:id/impact')
  async impact(@Req() req: ApiRequest, @Param('id') id: string, @Query('depth') depth?: string) {
    return { impact: await this.assets.impact(requireTenant(req), id, depth ? Number(depth) : undefined) };
  }

  @RequirePermission('relationship.verify')
  @TenantScope(ASSET)
  @Post('assets/:id/relationships')
  createRelationship(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.assets.createRelationship(requireTenant(req), id, parseBody(manualEdgeBody, body));
  }

  @RequirePermission('product.manage')
  @TenantScope(ASSET)
  @Post('assets/:id/retire')
  @HttpCode(200)
  retire(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.assets.retire(requireTenant(req), id);
  }

  @RequirePermission('relationship.verify')
  @TenantScope(RELATIONSHIP)
  @Post('relationships/:id/verify')
  @HttpCode(200)
  verify(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.assets.setVerification(requireTenant(req), id, 'verified');
  }

  @RequirePermission('relationship.verify')
  @TenantScope(RELATIONSHIP)
  @Post('relationships/:id/reject')
  @HttpCode(200)
  reject(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.assets.setVerification(requireTenant(req), id, 'rejected');
  }

  @RequirePermission('relationship.verify')
  @TenantScope(RELATIONSHIP)
  @Post('relationships/:id/correct')
  @HttpCode(200)
  correct(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.assets.correct(requireTenant(req), id, parseBody(correctBody, body));
  }

  @RequirePermission('product.manage')
  @TenantScope(ALIAS)
  @Post('asset-aliases/:id/resolve')
  @HttpCode(200)
  resolve(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.assets.resolveAlias(requireTenant(req), id, parseBody(resolveBody, body).action);
  }
}
