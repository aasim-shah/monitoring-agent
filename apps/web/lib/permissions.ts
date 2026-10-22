import { can, type Permission, type Role } from '@pcp/shared-contracts';

/** UI-only check used to hide controls; the API remains the authority. */
export function roleCan(role: Role, permission: Permission): boolean {
  return can(
    {
      organizationId: '',
      actor: { kind: 'user', userId: '' },
      roles: [role],
      productIds: 'all',
      environmentIds: 'all',
      requestId: '',
    },
    permission,
  );
}
