import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, type Permission, type Role, type TenantContext } from '@pcp/shared-contracts';
import { ROLE_PERMISSIONS, can } from './index.js';

const ctx = (roles: Role[], productIds: string[] | 'all' = 'all'): TenantContext => ({
  organizationId: 'org',
  actor: { kind: 'user', userId: 'u' },
  roles,
  productIds,
  environmentIds: 'all',
  requestId: 'r',
});

const holders = (p: Permission) => ROLES.filter((r) => can(ctx([r]), p));

describe('role matrix matches spec §2.1', () => {
  it('everyone can view', () => expect(holders('org.view')).toEqual([...ROLES]));
  it('configure connections: owner, admin', () =>
    expect(holders('connection.configure')).toEqual(['owner', 'admin']));
  it('manage policies: owner, admin', () => expect(holders('policy.manage')).toEqual(['owner', 'admin']));
  it('approve actions: owner by default (policy may extend)', () =>
    expect(holders('action.approve')).toEqual(['owner']));
  it('manage members: owner, admin', () => expect(holders('org.members.manage')).toEqual(['owner', 'admin']));
  it('owner holds every permission', () => expect(ROLE_PERMISSIONS.owner).toEqual([...PERMISSIONS]));
  it('viewer is read-only', () =>
    expect([...ROLE_PERMISSIONS.viewer].sort()).toEqual(
      [
        'agent.view',
        'asset.view',
        'connection.view',
        'incident.view',
        'org.view',
        'product.view',
        'report.view',
        'telemetry.query',
      ].sort(),
    ));
  it('analyst cannot change anything', () => {
    const writes = ROLE_PERMISSIONS.analyst.filter((p) =>
      /manage|configure|propose|approve|enroll|revoke|verify|tail|inspect/.test(p),
    );
    expect(writes).toEqual([]);
  });
});

describe('can() with product scope', () => {
  it('restricts a product-scoped analyst to listed products', () => {
    const scoped = ctx(['analyst'], ['p1']);
    expect(can(scoped, 'asset.view', { productId: 'p1' })).toBe(true);
    expect(can(scoped, 'asset.view', { productId: 'p2' })).toBe(false);
  });
  it('allows any product for all-products members', () =>
    expect(can(ctx(['analyst']), 'asset.view', { productId: 'p2' })).toBe(true));
  it('grants nothing without roles', () => expect(can(ctx([]), 'org.view')).toBe(false));
});
