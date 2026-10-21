import type { Permission, TenantContext } from '@pcp/shared-contracts';
import { ROLE_PERMISSIONS } from './role-matrix.js';

/** True when one of the caller's roles grants `permission` within the optional product scope. */
export function can(ctx: TenantContext, permission: Permission, scope: { productId?: string } = {}): boolean {
  const granted = ctx.roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission));
  if (!granted) return false;
  if (scope.productId && ctx.productIds !== 'all') return ctx.productIds.includes(scope.productId);
  return true;
}
