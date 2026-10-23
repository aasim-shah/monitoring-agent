import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import {
  createProduct,
  headers,
  login,
  ownerWithOrg,
  signUpAndVerify,
  type Owner,
} from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const req = async (cookie: string, method: 'GET' | 'POST', url: string, payload?: Json) => {
  const { 'content-type': _, ...noBody } = headers(cookie);
  const res = await t.app.inject({
    method,
    url,
    headers: payload === undefined ? noBody : headers(cookie),
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, json: (res.body ? res.json() : {}) as Json, body: res.body };
};

async function asset(
  org: string,
  type: string,
  name: string,
  products: string[],
  attrs: Json = {},
  lifecycle = 'active',
) {
  const id = randomUUID();
  await sql(
    `INSERT INTO assets (id, organization_id, asset_type, name, source, identity_key, attributes, lifecycle)
     VALUES ($1, $2, $3::asset_type, $4, 'agent', $5, $6, $7::asset_lifecycle)`,
    [id, org, type, name, `test:${id}`, JSON.stringify(attrs), lifecycle],
  );
  for (const p of products)
    await sql(`INSERT INTO product_assets (organization_id, product_id, asset_id) VALUES ($1, $2, $3)`, [
      org,
      p,
      id,
    ]);
  return id;
}

async function edge(
  org: string,
  source: string,
  target: string,
  type: string,
  verification = 'verified',
  confidence = 0.95,
) {
  const id = randomUUID();
  await sql(
    `INSERT INTO asset_relationships (id, organization_id, source_asset_id, target_asset_id, relationship_type, confidence, verification, updated_at)
     VALUES ($1, $2, $3, $4, $5::relationship_type, $6, $7::verification, now())`,
    [id, org, source, target, type, confidence, verification],
  );
  await sql(
    `INSERT INTO relationship_evidence (id, organization_id, relationship_id, kind) VALUES ($1, $2, $3, 'direct')`,
    [randomUUID(), org, id],
  );
  return id;
}

async function scopedMember(owner: Owner, role: string, productIds: string[]) {
  const email = await signUpAndVerify(t);
  const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  await sql(
    `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids)
     VALUES ($1, $2, $3, $4, false, $5::uuid[])`,
    [randomUUID(), owner.orgId, u!.id, role, productIds],
  );
  return login(t, email);
}

/** Spec §10.5-like: a VPS shared by FireMaps and Product B. */
async function sharedHost() {
  const owner = await ownerWithOrg(t);
  const fire = await createProduct(t, owner, `FireMaps-${randomUUID().slice(0, 6)}`);
  const b = await createProduct(t, owner, `ProductB-${randomUUID().slice(0, 6)}`);
  const org = owner.orgId;
  const host = await asset(org, 'host', 'shared-vps', [fire, b], { agentId: randomUUID() });
  const fireApi = await asset(org, 'service', 'firemaps-api-secret-name', [fire]);
  const fireSite = await asset(org, 'website', 'firemaps.example', [fire]);
  const bWorker = await asset(org, 'service', 'b-worker', [b]);
  const bSite = await asset(org, 'website', 'b.example', [b]);
  await edge(org, host, fireApi, 'HOSTS');
  await edge(org, fireSite, host, 'ROUTES_TO');
  await edge(org, host, bWorker, 'HOSTS');
  await edge(org, bSite, host, 'ROUTES_TO', 'proposed', 0.8);
  return { owner, fire, b, host, fireApi, fireSite, bWorker, bSite };
}

describe('product scope on the graph (Review Focus #1, TC-10-06)', () => {
  it('an analyst of Product B sees the shared host and B only: assets, edges, topology, impact', async () => {
    const f = await sharedHost();
    const analyst = await scopedMember(f.owner, 'analyst', [f.b]);
    const list = await req(analyst, 'GET', `/api/v1/products/${f.b}/assets`);
    expect(list.status).toBe(200);
    expect((list.json.assets as Json[]).map((a) => a.name).sort()).toEqual([
      'b-worker',
      'b.example',
      'shared-vps',
    ]);
    expect((await req(analyst, 'GET', `/api/v1/assets/${f.fireApi}`)).status).toBe(404);
    expect((await req(analyst, 'GET', `/api/v1/products/${f.fire}/assets`)).status).toBe(404);

    const rels = await req(analyst, 'GET', `/api/v1/assets/${f.host}/relationships`);
    expect((rels.json.relationships as Json[]).map((r) => r.other.name).sort()).toEqual([
      'b-worker',
      'b.example',
    ]);

    const topo = await req(analyst, 'GET', `/api/v1/products/${f.b}/topology`);
    expect((topo.json.nodes as Json[]).map((n) => n.name).sort()).toEqual([
      'b-worker',
      'b.example',
      'shared-vps',
    ]);
    expect(topo.json.edges).toHaveLength(2);

    const impact = await req(analyst, 'GET', `/api/v1/assets/${f.host}/impact`);
    expect(impact.status).toBe(200);
    expect((impact.json.impact as Json[]).map((i) => i.name).sort()).toEqual(['b-worker', 'b.example']);
    for (const leak of ['firemaps', f.fireApi, f.fireSite, f.fire]) expect(impact.body).not.toContain(leak);
    expect(rels.body).not.toContain(f.fireApi);
    expect(topo.body).not.toContain('firemaps');

    // The owner sees everything from the host.
    const all = await req(f.owner.cookie, 'GET', `/api/v1/assets/${f.host}/impact`);
    expect((all.json.impact as Json[]).map((i) => i.name).sort()).toEqual([
      'b-worker',
      'b.example',
      'firemaps-api-secret-name',
      'firemaps.example',
    ]);
  });
});

describe('impact (UC-10-10, TC-10-07)', () => {
  it('terminates on cycles, respects depth (default 4, max 6), and classifies dependents', async () => {
    const owner = await ownerWithOrg(t);
    const p = await createProduct(t, owner, `Chain-${randomUUID().slice(0, 6)}`);
    const org = owner.orgId;
    const chain: string[] = [];
    for (let i = 0; i < 9; i++) chain.push(await asset(org, 'service', `svc-${i}`, [p]));
    for (let i = 1; i < 9; i++) await edge(org, chain[i]!, chain[i - 1]!, 'DEPENDS_ON');
    await edge(org, chain[0]!, chain[1]!, 'DEPENDS_ON'); // cycle 0 <-> 1
    const names = async (depth?: number) =>
      (
        (await req(owner.cookie, 'GET', `/api/v1/assets/${chain[0]}/impact${depth ? `?depth=${depth}` : ''}`))
          .json.impact as Json[]
      ).map((i) => i.name);
    expect(await names()).toEqual(['svc-1', 'svc-2', 'svc-3', 'svc-4']);
    expect(await names(10)).toHaveLength(6);

    // Classes: a failing database dependent is confirmed; a proposed low-confidence path is unknown.
    const connectionId = randomUUID();
    await sql(
      `INSERT INTO connections (id, organization_id, provider, display_name, execution_location, status, config, updated_at)
       VALUES ($1, $2, 'postgres', 'Orders DB', 'private', 'connected', '{}', now())`,
      [connectionId, org],
    );
    await sql(
      `INSERT INTO connection_health (id, organization_id, connection_id, ok, reason) VALUES ($1, $2, $3, false, 'network_unreachable')`,
      [randomUUID(), org, connectionId],
    );
    const db = await asset(org, 'database', 'orders-db', [p], { connectionId });
    const root = await asset(org, 'host', 'root-host', [p]);
    const weak = await asset(org, 'website', 'weak.example', [p]);
    await edge(org, db, root, 'DEPLOYED_ON');
    await edge(org, weak, root, 'ROUTES_TO', 'proposed', 0.3);
    const impact = (await req(owner.cookie, 'GET', `/api/v1/assets/${root}/impact`)).json.impact as Json[];
    expect(Object.fromEntries(impact.map((i) => [i.name, i.impact]))).toEqual({
      'orders-db': 'confirmed',
      'weak.example': 'unknown',
    });
    expect(impact.find((i) => i.name === 'orders-db')).toMatchObject({
      distance: 1,
      via: ['root-host', 'orders-db'],
    });
  });
});

describe('review and correction (UC-10-04..06)', () => {
  it('verifies, rejects, and corrects edges with audit; viewers cannot', async () => {
    const f = await sharedHost();
    const review = await req(f.owner.cookie, 'GET', `/api/v1/products/${f.b}/review`);
    const proposed = (review.json.edges as Json[]).find((e) => e.source.name === 'b.example')!;
    expect(proposed).toMatchObject({ type: 'ROUTES_TO', verification: 'proposed' });
    const viewer = await scopedMember(f.owner, 'viewer', [f.b]);
    expect((await req(viewer, 'POST', `/api/v1/relationships/${proposed.id}/verify`, {})).status).toBe(404);
    expect(
      (await req(f.owner.cookie, 'POST', `/api/v1/relationships/${proposed.id}/verify`, {})).json
        .verification,
    ).toBe('verified');
    expect(
      (await req(f.owner.cookie, 'POST', `/api/v1/relationships/${proposed.id}/reject`, {})).json
        .verification,
    ).toBe('rejected');
    // Correct: the website actually routes to the worker service.
    const corrected = await req(f.owner.cookie, 'POST', `/api/v1/relationships/${proposed.id}/correct`, {
      targetAssetId: f.bWorker,
      type: 'DEPENDS_ON',
    });
    expect(corrected.status, corrected.body).toBe(200);
    const rows = await sql<{ type: string; verification: string }>(
      `SELECT relationship_type::text AS type, verification::text FROM asset_relationships WHERE source_asset_id = $1 ORDER BY 1`,
      [f.bSite],
    );
    expect(rows).toEqual([
      { type: 'DEPENDS_ON', verification: 'verified' },
      { type: 'ROUTES_TO', verification: 'rejected' },
    ]);
    const audit = await sql<{ action: string }>(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'relationship.%' ORDER BY created_at`,
      [f.owner.orgId],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'relationship.verified',
      'relationship.rejected',
      'relationship.corrected',
    ]);
    // A scoped member cannot point an edge at an asset outside their products.
    const operator = await scopedMember(f.owner, 'operator', [f.b]);
    expect(
      (
        await req(operator, 'POST', `/api/v1/assets/${f.bWorker}/relationships`, {
          targetAssetId: f.fireApi,
          type: 'CONNECTS_TO',
        })
      ).status,
    ).toBe(404);
  });

  it('adds manual assets and edges, retires assets, and resolves alias candidates', async () => {
    const owner = await ownerWithOrg(t);
    const p = await createProduct(t, owner, `Manual-${randomUUID().slice(0, 6)}`);
    const created = await req(owner.cookie, 'POST', `/api/v1/products/${p}/assets`, {
      assetType: 'external',
      name: 'Stripe',
    });
    expect(created.status, created.body).toBe(201);
    expect(created.json).toMatchObject({ lifecycle: 'manually_managed', source: 'manual' });
    const api = await asset(owner.orgId, 'service', 'api', [p]);
    const manual = await req(owner.cookie, 'POST', `/api/v1/assets/${api}/relationships`, {
      targetAssetId: created.json.id,
      type: 'DEPENDS_ON',
    });
    expect(manual.json).toMatchObject({ verification: 'verified' });
    expect(
      (await req(owner.cookie, 'POST', `/api/v1/assets/${created.json.id}/retire`, {})).json.lifecycle,
    ).toBe('retired');

    const older = await asset(owner.orgId, 'host', 'vps-1', [p]);
    const newer = await asset(owner.orgId, 'host', 'vps-1', [p]);
    const svc = await asset(owner.orgId, 'service', 'redis', [p]);
    await edge(owner.orgId, newer, svc, 'HOSTS');
    const [alias] = await sql<{ id: string }>(
      `INSERT INTO asset_aliases (id, organization_id, asset_id, candidate_asset_id, reason) VALUES ($1, $2, $3, $4, 'same name') RETURNING id`,
      [randomUUID(), owner.orgId, newer, older],
    );
    const review = await req(owner.cookie, 'GET', `/api/v1/products/${p}/review`);
    expect((review.json.aliases as Json[]).map((a) => a.id)).toContain(alias!.id);
    expect(
      (await req(owner.cookie, 'POST', `/api/v1/asset-aliases/${alias!.id}/resolve`, { action: 'merge' }))
        .status,
    ).toBe(200);
    const moved = await sql<{ source: string }>(
      `SELECT source_asset_id AS source FROM asset_relationships WHERE target_asset_id = $1`,
      [svc],
    );
    expect(moved).toEqual([{ source: older }]);
    const [merged] = await sql<{ lifecycle: string; into: string }>(
      `SELECT lifecycle::text, attributes->>'mergedInto' AS into FROM assets WHERE id = $1`,
      [newer],
    );
    expect(merged).toEqual({ lifecycle: 'retired', into: older });
  });
});

describe('coverage (UC-10-11)', () => {
  it('counts assets by lifecycle and type, and edges by verification', async () => {
    const f = await sharedHost();
    await asset(f.owner.orgId, 'service', 'gone', [f.b], {}, 'missing');
    const c = (await req(f.owner.cookie, 'GET', `/api/v1/products/${f.b}/coverage`)).json;
    expect(c).toMatchObject({
      assets: 4,
      byLifecycle: { active: 3, missing: 1 },
      byType: { host: 1, service: 2, website: 1 },
      edges: { verified: 1, proposed: 1 },
    });
  });
});
