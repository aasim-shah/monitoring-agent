import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaClient } from '@pcp/database';
import type { Permission, Role } from '@pcp/shared-contracts';
import { can, withTenant } from '@pcp/tenant-security';
import { PRISMA } from '../tokens.js';
import {
  IS_PUBLIC,
  REQUIRED_PERMISSION,
  SESSION_ONLY,
  TENANT_SCOPE,
  type TenantResource,
  type TenantScopeOptions,
} from './decorators.js';
import { notFound } from './errors.js';
import { requireAuth, type ApiRequest } from './request.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMPLIED: Record<string, TenantResource> = {
  orgId: 'organization',
  productId: 'product',
  environmentId: 'environment',
};

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
    const scope = this.reflector.getAllAndOverride<TenantScopeOptions | undefined>(TENANT_SCOPE, targets);
    if (!permission || !scope)
      throw new Error(
        `route ${context.getClass().name}.${context.getHandler().name} lacks @RequirePermission/@TenantScope`,
      );

    const req = context.switchToHttp().getRequest<ApiRequest>();
    const { user } = requireAuth(req);
    const id = (req.params as Record<string, string | undefined>)[scope.param];
    if (!id || !UUID.test(id)) throw notFound();

    const resource = 'resource' in scope ? scope.resource : IMPLIED[scope.param]!;
    const resolved = await this.resolve(resource, id, user.id);
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
    let productId = resolved.productId;
    if (resource === 'connection' && ctx.productIds !== 'all') {
      // Product-scoped members reach a connection only through a resource scope on one of their products.
      const allowed = ctx.productIds;
      const hit = await withTenant(this.prisma, ctx, (tx) =>
        tx.connectionResourceScope.findFirst({
          where: { connectionId: id, productId: { in: allowed } },
          select: { productId: true },
        }),
      );
      if (!hit) throw notFound();
      productId = hit.productId;
    }
    if (!can(ctx, permission, productId ? { productId } : {})) throw notFound();
    req.tenant = ctx;
    return true;
  }

  private async resolve(
    resource: TenantResource,
    id: string,
    userId: string,
  ): Promise<{ organizationId: string; productId?: string } | null> {
    if (resource === 'organization') return { organizationId: id };
    if (resource === 'connection') {
      const [row] = await this.prisma.$queryRaw<{ org: string | null }[]>`
        SELECT pcp_resolve_connection_org(${id}::uuid, ${userId}::uuid)::text AS org`;
      return row?.org ? { organizationId: row.org } : null;
    }
    if (resource === 'agent') {
      const [row] = await this.prisma.$queryRaw<{ org: string | null; product: string | null }[]>`
        SELECT pcp_resolve_agent_org(${id}::uuid, ${userId}::uuid)::text AS org,
               pcp_resolve_agent_product(${id}::uuid, ${userId}::uuid)::text AS product`;
      return row?.org ? { organizationId: row.org, productId: row.product ?? undefined } : null;
    }
    if (resource === 'asset' || resource === 'relationship' || resource === 'asset_alias') {
      // Organization only: assets can belong to several products, so product scope is
      // enforced by the assets service (an edge needs both ends visible, D7).
      const [row] = await this.prisma.$queryRaw<{ org: string | null }[]>`
        SELECT CASE ${resource}
          WHEN 'asset' THEN pcp_resolve_asset_org(${id}::uuid, ${userId}::uuid)
          WHEN 'relationship' THEN pcp_resolve_relationship_org(${id}::uuid, ${userId}::uuid)
          ELSE pcp_resolve_asset_alias_org(${id}::uuid, ${userId}::uuid) END::text AS org`;
      return row?.org ? { organizationId: row.org } : null;
    }
    if (resource === 'alert_rule' || resource === 'incident' || resource === 'notification_channel') {
      const [row] = await this.prisma.$queryRaw<{ org: string; product: string | null }[]>`
        SELECT organization_id::text AS org, product_id::text AS product
        FROM pcp_resolve_alerting_object(${resource}, ${id}::uuid, ${userId}::uuid)`;
      return row ? { organizationId: row.org, productId: row.product ?? undefined } : null;
    }
    if (resource === 'product') {
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
