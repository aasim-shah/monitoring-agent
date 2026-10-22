import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException } from '../../common/errors.js';
import { isUniqueViolation } from '../../common/tenant.js';
import { PRISMA } from '../../tokens.js';

@Injectable()
export class ProductsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async create(
    ctx: TenantContext,
    input: { name: string; description?: string; domains: string[]; repositories: string[] },
  ) {
    try {
      return await withTenant(this.prisma, ctx, (tx) =>
        tx.product.create({ data: { organizationId: ctx.organizationId, ...input } }),
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ApiException(409, 'product_exists', 'A product with this name already exists');
      throw err;
    }
  }

  get(ctx: TenantContext, productId: string) {
    return withTenant(this.prisma, ctx, (tx) =>
      tx.product.findUniqueOrThrow({
        where: { id: productId },
        include: { environments: { orderBy: { createdAt: 'asc' } } },
      }),
    );
  }

  async createEnvironment(ctx: TenantContext, productId: string, name: string) {
    try {
      return await withTenant(this.prisma, ctx, (tx) =>
        tx.environment.create({ data: { organizationId: ctx.organizationId, productId, name } }),
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ApiException(409, 'environment_exists', 'An environment with this name already exists');
      throw err;
    }
  }
}
