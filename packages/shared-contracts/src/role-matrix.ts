import { PERMISSIONS, type Permission, type Role, type TenantContext } from './tenancy.js';

const VIEW: readonly Permission[] = [
  'org.view',
  'product.view',
  'connection.view',
  'agent.view',
  'asset.view',
  'telemetry.query',
  'incident.view',
  'report.view',
];

/**
 * Default permissions per role (spec §2.1, ADR 0003). "Policy-dependent" approval
 * is granted to admins/operators by action policies (M16), not by default.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  // Approving actions, exporting all data, and deleting the organization stay with owners.
  admin: PERMISSIONS.filter((p) => !['action.approve', 'org.export', 'org.delete'].includes(p)),
  operator: [
    ...VIEW,
    'agent.enroll',
    'pack.manage',
    'relationship.verify',
    'logs.tail',
    'data.inspect',
    'incident.manage',
    'action.propose',
    'report.manage',
    'ai.use',
  ],
  analyst: [...VIEW, 'ai.use'],
  viewer: VIEW,
};

/** True when one of the caller's roles grants `permission` within the optional product scope. */
export function can(ctx: TenantContext, permission: Permission, scope: { productId?: string } = {}): boolean {
  const granted = ctx.roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission));
  if (!granted) return false;
  if (scope.productId && ctx.productIds !== 'all') return ctx.productIds.includes(scope.productId);
  return true;
}
