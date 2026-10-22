import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { createProduct, headers, login, ownerWithOrg, signUpAndVerify } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

interface Entry {
  id: string;
  action: string;
  actorType: string;
  actorId: string;
  targetType: string;
  targetId: string;
}

const auditLog = async (orgId: string, cookie: string) => {
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/v1/organizations/${orgId}/audit-logs`,
    headers: headers(cookie),
  });
  return { status: res.statusCode, entries: (res.json() as { entries?: Entry[] }).entries ?? [] };
};

describe('audit log', () => {
  it('records organization creation and the first owner (UC-01-07)', async () => {
    const owner = await ownerWithOrg(t);
    const { status, entries } = await auditLog(owner.orgId, owner.cookie);
    expect(status).toBe(200);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('organization.created');
    expect(actions).toContain('member.owner_created');
    const created = entries.find((e) => e.action === 'organization.created')!;
    expect(created).toMatchObject({ actorType: 'user', targetType: 'organization', targetId: owner.orgId });
  });

  it('records product, environment, and settings changes, newest first', async () => {
    const owner = await ownerWithOrg(t);
    const productId = await createProduct(t, owner);
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/environments`,
      headers: headers(owner.cookie),
      payload: { name: 'Production' },
    });
    await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${owner.orgId}/settings`,
      headers: headers(owner.cookie),
      payload: { timezone: 'UTC' },
    });
    const { entries } = await auditLog(owner.orgId, owner.cookie);
    expect(entries.slice(0, 3).map((e) => e.action)).toEqual([
      'organization.settings_updated',
      'environment.created',
      'product.created',
    ]);
    expect(entries[2]).toMatchObject({ targetType: 'product', targetId: productId });
  });

  it('is append-only for the application role', async () => {
    await expect(t.prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'tampered'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/);
  });

  it('is hidden from viewers and from other tenants', async () => {
    const owner = await ownerWithOrg(t);
    const viewerEmail = await signUpAndVerify(t);
    const [viewer] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [viewerEmail]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`,
      [randomUUID(), owner.orgId, viewer!.id],
    );
    expect((await auditLog(owner.orgId, await login(t, viewerEmail))).status).toBe(404);

    const other = await ownerWithOrg(t, 'Other');
    expect((await auditLog(owner.orgId, other.cookie)).status).toBe(404);
  });

  it('pages with limit and before', async () => {
    const owner = await ownerWithOrg(t);
    for (const name of ['A', 'B', 'C']) await createProduct(t, owner, name);
    const first = await t.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${owner.orgId}/audit-logs?limit=2`,
      headers: headers(owner.cookie),
    });
    const page = first.json() as { entries: Array<Entry & { createdAt: string }>; nextBefore: string | null };
    expect(page.entries).toHaveLength(2);
    expect(page.nextBefore).toBeTruthy();
    const second = await t.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${owner.orgId}/audit-logs?limit=100&before=${encodeURIComponent(page.nextBefore!)}`,
      headers: headers(owner.cookie),
    });
    const rest = (second.json() as { entries: Entry[] }).entries;
    expect(rest.length).toBeGreaterThanOrEqual(3);
    const firstIds = new Set(page.entries.map((e) => e.id));
    expect(rest.some((e) => firstIds.has(e.id))).toBe(false);
    const all = [...page.entries, ...rest].map((e) => e.action);
    expect(all.filter((a) => a === 'product.created')).toHaveLength(3);
  });
});
