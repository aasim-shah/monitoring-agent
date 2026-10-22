import { ROLES, type Role } from '@pcp/shared-contracts';

const RANK: Record<Role, number> = { owner: 5, admin: 4, operator: 3, analyst: 2, viewer: 1 };
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Operator',
  analyst: 'Analyst',
  viewer: 'Viewer',
};

/** Roles an actor may grant (the API enforces the same rule: role_above_actor). */
export const rolesAtOrBelow = (actor: Role): Role[] => ROLES.filter((r) => RANK[r] <= RANK[actor]);
