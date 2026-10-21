import { PERMISSIONS, type Permission, type Role } from '@pcp/shared-contracts';

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
  admin: PERMISSIONS.filter((p) => p !== 'action.approve'),
  operator: [
    ...VIEW,
    'agent.enroll',
    'pack.manage',
    'relationship.verify',
    'logs.tail',
    'incident.manage',
    'action.propose',
    'report.manage',
    'ai.use',
  ],
  analyst: [...VIEW, 'ai.use'],
  viewer: VIEW,
};
