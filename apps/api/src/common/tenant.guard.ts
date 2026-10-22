import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaClient } from '@pcp/database';
import type { Permission, Role } from '@pcp/shared-contracts';
import { can } from '@pcp/tenant-security';
import { PRISMA } from '../tokens.js';
import {
  IS_PUBLIC,
  REQUIRED_PERMISSION,
  SESSION_ONLY,
  TENANT_SCOPE,
  type TenantScopeParam,
} from './decorators.js';
import { notFound } from './errors.js';
import { requireAuth, type ApiRequest } from './request.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Membership {
  organization_id: string;
  role: Role;
  all_products: boolean;
  product_ids: string[];
}

/**
 * Builds the TenantContext for organization-scoped routes (ADR 0003). Any denial —
 * unknown resource, non-member, missing permission, out-of-scope product — is 404,
 * so callers cannot learn that a resource exists.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SESSION_ONLY, targets)) return true;

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, targets);
    const scope = this.reflector.getAllAndOverride<{ param: TenantScopeParam } | undefined>(
      TENANT_SCOPE,
      targets,
    );
    if (!permission || !scope)
      throw new Error(
        `route ${context.getClass().name}.${context.getHandler().name} lacks @RequirePermission/@TenantScope`,
      );

    const req = context.switchToHttp().getRequest<ApiRequest>();
    const { user } = requireAuth(req);
    const id = (req.params as Record<string, string | undefined>)[scope.param];
    if (!id || !UUID.test(id)) throw notFound();

    const resolved = await this.resolve(scope.param, id, user.id);
    if (!resolved) throw notFound();

    const [membership] = await this.prisma.$queryRaw<Membership[]>`
      SELECT organization_id, role, all_products, product_ids
      FROM pcp_user_memberships(${user.id}::uuid)
      WHERE organization_id = ${resolved.organizationId}::uuid`;
    if (!membership) throw notFound();

    const ctx = {
      organizationId: membership.organization_id,
      actor: { kind: 'user' as const, userId: user.id },
      roles: [membership.role],
      productIds: membership.all_products ? ('all' as const) : membership.product_ids,
      environmentIds: 'all' as const,
      requestId: String(req.id),
    };
    if (!can(ctx, permission, resolved.productId ? { productId: resolved.productId } : {})) throw notFound();
    req.tenant = ctx;
    return true;
  }

  private async resolve(
    param: TenantScopeParam,
    id: string,
    userId: string,
  ): Promise<{ organizationId: string; productId?: string } | null> {
    if (param === 'orgId') return { organizationId: id };
    if (param === 'productId') {
      const [row] = await this.prisma.$queryRaw<{ org: string | null }[]>`
        SELECT pcp_resolve_product_org(${id}::uuid, ${userId}::uuid)::text AS org`;
      return row?.org ? { organizationId: row.org, productId: id } : null;
    }
    const [row] = await this.prisma.$queryRaw<{ org: string | null; product: string | null }[]>`
      SELECT pcp_resolve_environment_org(${id}::uuid, ${userId}::uuid)::text AS org,
             pcp_resolve_environment_product(${id}::uuid, ${userId}::uuid)::text AS product`;
    return row?.org ? { organizationId: row.org, productId: row.product ?? undefined } : null;
  }
}
