import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOGLE_DATA_SCOPES } from '@pcp/connectors-google';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { createProduct, headers, ownerWithOrg, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const partial = GOOGLE_DATA_SCOPES.filter(
  (s) => !s.endsWith('/adwords') && !s.endsWith('/bigquery.readonly'),
);

async function googleConnection(owner: Owner, scopes: Array<[string, string, string, string]>) {
  const id = randomUUID();
  await sql(
    `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, granted_scopes, account_email, updated_at)
     VALUES ($1, $2, 'google', 'Google', 'connected', 'cloud', $3, 'ops@acme.example', now())`,
    [id, owner.orgId, partial],
  );
  for (const [resourceType, externalId, name, productId] of scopes)
    await sql(
      `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [owner.orgId, id, externalId, resourceType, name, productId],
    );
  return id;
}

const value = (
  owner: Owner,
  conn: string,
  externalId: string,
  metric: string,
  d: string,
  v: number,
  completeness = 'complete',
  dimension = '',
) =>
  sql(
    `INSERT INTO metric_aggregates (organization_id, connection_id, resource_type, external_id, metric, dimension, day, value, completeness)
     VALUES ($1, $2, 'google_ga4_property', $3, $4, $5, $6, $7, $8)`,
    [owner.orgId, conn, externalId, metric, dimension, d, v, completeness],
  );

const run = (owner: Owner, conn: string, status: string, minutesAgo: number, error: string | null = null) =>
  sql(
    `INSERT INTO sync_runs (organization_id, connection_id, kind, status, started_at, finished_at, error_code, error_message)
     VALUES ($1, $2, 'sync', $3, now() - make_interval(mins => $4), now() - make_interval(mins => $4), $5, $6)`,
    [owner.orgId, conn, status, minutesAgo, error ? 'rate_limited' : null, error],
  );

const kpis = (owner: Owner, productId: string, range = '7d') => {
  const { 'content-type': _ct, ...bare } = headers(owner.cookie);
  return t.app.inject({
    method: 'GET',
    url: `/api/v1/products/${productId}/kpis?range=${range}`,
    headers: bare,
  });
};

describe('KPI API (WB-09 UC-09-06, BR-09-05)', () => {
  it('returns daily values of product-scoped resources with nulls for missing days, partial today, and totals', async () => {
    const owner = await ownerWithOrg(t);
    const shop = await createProduct(t, owner, 'Shop');
    const blog = await createProduct(t, owner, 'Blog');
    const conn = await googleConnection(owner, [
      ['google_ga4_property', 'properties/1', 'Shop web', shop],
      ['google_ga4_property', 'properties/2', 'Blog web', blog],
      ['google_firebase_app', '1:1:android:a', 'Shop Android', shop],
    ]);
    await value(owner, conn, 'properties/1', 'activeUsers', day(-1), 100);
    await value(owner, conn, 'properties/1', 'activeUsers', day(0), 40, 'partial');
    await value(owner, conn, 'properties/1', 'sessions', day(-1), 150);
    await value(owner, conn, 'properties/1', 'sessions', day(0), 60, 'partial');
    await value(owner, conn, 'properties/1', 'sessions', day(-1), 90, 'complete', 'Organic Search');
    await value(owner, conn, 'properties/1', 'sessions', day(0), 30, 'partial', 'Organic Search');
    await value(owner, conn, 'properties/2', 'activeUsers', day(-1), 999);
    await run(owner, conn, 'succeeded', 20);

    const res = await kpis(owner, shop);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.days).toHaveLength(7);
    expect(body.days.at(-1)).toBe(day(0));
    expect(body.resources.map((r: { externalId: string }) => r.externalId)).toEqual([
      'properties/1',
      '1:1:android:a',
    ]);
    // Firebase apps have no daily values; they are listed for the Mobile page.
    expect(body.resources[1]).toMatchObject({ resourceType: 'google_firebase_app', kpis: [] });
    const [shopWeb] = body.resources;
    expect(shopWeb).toMatchObject({
      connectionId: conn,
      resourceType: 'google_ga4_property',
      name: 'Shop web',
    });
    const users = shopWeb.kpis.find((k: { key: string }) => k.key === 'ga4.activeUsers');
    expect(users.points.at(-1)).toEqual({ day: day(0), value: 40, completeness: 'partial' });
    expect(users.points.at(-2)).toEqual({ day: day(-1), value: 100, completeness: 'complete' });
    expect(users.points.at(-3)).toEqual({ day: day(-2), value: null, completeness: null });
    expect(users.total).toBe(70);
    expect(shopWeb.kpis.find((k: { key: string }) => k.key === 'ga4.sessions').total).toBe(210);
    expect(shopWeb.kpis.find((k: { key: string }) => k.key === 'ga4.newUsers').total).toBeNull();
    expect(shopWeb.breakdown).toEqual({ sessionsByChannel: [{ channel: 'Organic Search', value: 120 }] });
    expect(body.connections).toEqual([
      expect.objectContaining({
        id: conn,
        accountEmail: 'ops@acme.example',
        services: expect.objectContaining({ ga4: 'available', ads: 'permission_denied' }),
        freshness: expect.objectContaining({ status: 'current', reason: null }),
      }),
    ]);
    expect(body.gaps).toEqual(['Google Ads: access not granted', 'BigQuery exports: access not granted']);
  });

  it('marks a source stale with the reason when its last sync failed, and keeps the values (BR-08-06)', async () => {
    const owner = await ownerWithOrg(t);
    const shop = await createProduct(t, owner, 'Shop');
    const conn = await googleConnection(owner, [['google_ga4_property', 'properties/7', 'Shop web', shop]]);
    await value(owner, conn, 'properties/7', 'sessions', day(-1), 15);
    await run(owner, conn, 'succeeded', 180);
    await run(owner, conn, 'failed', 5, 'Exhausted property tokens');
    const body = (await kpis(owner, shop)).json();
    expect(body.connections[0].freshness).toMatchObject({
      status: 'stale',
      reason: 'Exhausted property tokens',
    });
    expect(body.resources[0].kpis.find((k: { key: string }) => k.key === 'ga4.sessions').total).toBe(15);
  });

  it('says Google is not connected rather than showing zeros', async () => {
    const owner = await ownerWithOrg(t);
    const shop = await createProduct(t, owner, 'Shop');
    const body = (await kpis(owner, shop)).json();
    expect(body).toMatchObject({ connections: [], resources: [], gaps: ['Google: not connected'] });
  });

  it('rejects an unknown range', async () => {
    const owner = await ownerWithOrg(t);
    const shop = await createProduct(t, owner, 'Shop');
    expect((await kpis(owner, shop, '1y')).statusCode).toBe(400);
  });
});
