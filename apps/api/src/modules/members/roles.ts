import type { Role } from '@pcp/shared-contracts';
import { ApiException } from '../../common/errors.js';

const RANK: Record<Role, number> = { owner: 5, admin: 4, operator: 3, analyst: 2, viewer: 1 };

/** An actor can grant, change, or remove only roles at or below their own. */
export function assertRoleNotAbove(actor: Role, ...roles: Role[]): void {
  if (roles.some((r) => RANK[r] > RANK[actor])) {
    throw new ApiException(403, 'role_above_actor', 'You cannot grant or change a role above your own');
  }
}
