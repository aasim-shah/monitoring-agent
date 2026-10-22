import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import {
  createProduct,
  enrollMfa,
  headers,
  login,
  ownerWithOrg,
  signUpAndVerify,
} from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

const get = (url: string, cookie: string) => t.app.inject({ method: 'GET', url, headers: headers(cookie) });
const post = (url: string, cookie: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url, headers: headers(cookie), payload });

describe('organizations', () => {
  it('makes the creator owner and requires MFA before tenant routes (TC-01-05)', async () => {
    const email = await signUpAndVerify(t);
    const cookie = await login(t, email);
    const created = await post('/api/v1/organizations', cookie, {
      name: 'Example Company',
      timezone: 'Europe/Berlin',
    });
    expect(created.statusCode).toBe(201);
    const orgId = created.json().id as string;

    const blocked = await get(`/api/v1/organizations/${orgId}`, cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('mfa_required');

    await enrollMfa(t, cookie);
    const org = await get(`/api/v1/organizations/${orgId}`, cookie);
    expect(org.statusCode).toBe(200);
    expect(org.json()).toMatchObject({
      id: orgId,
      name: 'Example Company',
      timezone: 'Europe/Berlin',
      role: 'owner',
    });
  });

  it('rejects an invalid timezone', async () => {
    const cookie = await login(t, await signUpAndVerify(t));
    const res = await post('/api/v1/organizations', cookie, { name: 'X', timezone: 'Mars/Olympus' });
    expect(res.statusCode).toBe(400);
  });

  it('updates settings', async () => {
    const owner = await ownerWithOrg(t);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${owner.orgId}/settings`,
      headers: headers(owner.cookie),
      payload: { timezone: 'Asia/Karachi', settings: { dataRetentionDays: 90 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ timezone: 'Asia/Karachi', settings: { dataRetentionDays: 90 } });
  });
});

describe('products and environments', () => {
  it('creates FireMaps with Production and Staging; duplicate environment → 409', async () => {
    const owner = await ownerWithOrg(t);
    const productId = await createProduct(t, owner);
    for (const name of ['Production', 'Staging']) {
      expect(
        (await post(`/api/v1/products/${productId}/environments`, owner.cookie, { name })).statusCode,
      ).toBe(201);
    }
    const dup = await post(`/api/v1/products/${productId}/environments`, owner.cookie, {
      name: 'Production',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('environment_exists');

    const product = await get(`/api/v1/products/${productId}`, owner.cookie);
    expect(product.json()).toMatchObject({
      name: 'FireMaps',
      domains: ['firemaps.example.com'],
      repositories: ['example/firemaps-api'],
    });
    expect(
      product
        .json()
        .environments.map((e: { name: string }) => e.name)
        .sort(),
    ).toEqual(['Production', 'Staging']);
    const overview = await get(`/api/v1/products/${productId}/overview`, owner.cookie);
    expect(overview.json().counts).toEqual({ environments: 2 });
  });

  it('rejects a duplicate product name with 409', async () => {
    const owner = await ownerWithOrg(t);
    await createProduct(t, owner, 'Storefront');
    const dup = await post(`/api/v1/organizations/${owner.orgId}/products`, owner.cookie, {
      name: 'Storefront',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('product_exists');
  });

  it('limits a product-scoped analyst to their product (TC-01-09)', async () => {
    const owner = await ownerWithOrg(t);
    const fireMaps = await createProduct(t, owner, 'FireMaps');
    const productB = await createProduct(t, owner, 'Product B');

    const analystEmail = await signUpAndVerify(t);
    const [analyst] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [analystEmail]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids)
       VALUES ($1, $2, $3, 'analyst', false, ARRAY[$4]::uuid[])`,
      [randomUUID(), owner.orgId, analyst!.id, productB],
    );
    const cookie = await login(t, analystEmail);
    expect((await get(`/api/v1/products/${productB}`, cookie)).statusCode).toBe(200);
    const denied = await get(`/api/v1/products/${fireMaps}`, cookie);
    expect(denied.statusCode).toBe(404);
    const write = await post(`/api/v1/products/${productB}/environments`, cookie, { name: 'Prod' });
    expect(write.statusCode).toBe(404);
  });

  it('returns 404 for malformed IDs', async () => {
    const owner = await ownerWithOrg(t);
    expect((await get('/api/v1/products/not-a-uuid', owner.cookie)).statusCode).toBe(404);
    expect((await get('/api/v1/organizations/not-a-uuid', owner.cookie)).statusCode).toBe(404);
  });
});
