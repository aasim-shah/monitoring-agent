import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CADDY_ADDRESS,
  agentEnv,
  asAgent,
  enrolledAgent,
  environmentFor,
  type EnrolledAgent,
} from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, login, ownerWithOrg, signUpAndVerify, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;
const dns = new Map<string, string[]>();

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv(), dns: async (h) => dns.get(h) ?? [] });
});

afterAll(async () => {
  await t?.close();
});

const heartbeat = (a: EnrolledAgent, ip: string) =>
  t.app.inject({
    method: 'POST',
    url: '/agent/v1/heartbeat',
    remoteAddress: CADDY_ADDRESS,
    headers: { 'x-client-cert-fingerprint': a.fingerprint, 'x-forwarded-for': `10.9.9.9, ${ip}` },
    payload: {
      protocolVersion: '1.0',
      sequence: Date.now() + Math.floor(Math.random() * 1000),
      agentVersion: '1.0.0',
      policyVersion: 1,
      capabilities: [],
      health: 'ok',
      queueDepth: 0,
      sentAt: new Date().toISOString(),
    },
  });

const inventory = (a: EnrolledAgent) =>
  t.app.inject({
    method: 'POST',
    url: '/agent/v1/inventory',
    ...asAgent(a.fingerprint),
    payload: {
      collectedAt: new Date().toISOString(),
      services: [
        {
          pack: 'redis',
          name: 'Redis',
          ports: [{ address: '127.0.0.1', port: 6379 }],
          processCount: 1,
          evidence: [],
        },
        {
          pack: 'postgresql',
          name: 'PostgreSQL',
          ports: [{ address: '127.0.0.1', port: 5432 }],
          processCount: 3,
          evidence: [],
        },
      ],
      listeners: [],
      warnings: [],
    },
  });

async function fixture() {
  const owner = await ownerWithOrg(t);
  const { productId, environmentId } = await environmentFor(t, owner);
  const domain = `shop-${randomUUID().slice(0, 8)}.example.test`;
  await sql(`UPDATE products SET domains = ARRAY[$2] WHERE id = $1`, [productId, domain]);
  const host = await enrolledAgent(t, owner, environmentId, { hostname: 'vps-1', machineId: randomUUID() });
  expect((await heartbeat(host, '203.0.113.7')).statusCode).toBe(202);
  await inventory(host);
  dns.set(domain, ['203.0.113.7']);
  return { owner, productId, environmentId, host, domain };
}

const run = (owner: Owner, productId: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1/products/${productId}/discovery/run`,
    headers: headers(owner.cookie),
    payload: {},
  });

const graph = async (productId: string) => {
  const assets = await sql<{ id: string; asset_type: string; name: string; lifecycle: string }>(
    `SELECT a.id, a.asset_type, a.name, a.lifecycle FROM assets a JOIN product_assets p ON p.asset_id = a.id WHERE p.product_id = $1 ORDER BY a.asset_type, a.name`,
    [productId],
  );
  const edges = await sql<{
    type: string;
    verification: string;
    source: string;
    target: string;
    confidence: string;
  }>(
    `SELECT r.relationship_type AS type, r.verification, s.name AS source, d.name AS target, r.confidence::text AS confidence
     FROM asset_relationships r JOIN assets s ON s.id = r.source_asset_id JOIN assets d ON d.id = r.target_asset_id
     WHERE r.source_asset_id = ANY($1) ORDER BY 1, 3, 4`,
    [assets.map((a) => a.id)],
  );
  return { assets, edges };
};

describe('discovery sources and rules (WB-10 UC-10-01/03)', () => {
  it('records the agent egress IP from the trusted proxy', async () => {
    const { host } = await fixture();
    const [row] = await sql<{ last_seen_ip: string }>(`SELECT last_seen_ip FROM agents WHERE id = $1`, [
      host.agentId,
    ]);
    expect(row!.last_seen_ip).toBe('203.0.113.7');
  });

  it('builds hosts, services, websites with evidence: HOSTS verified, ROUTES_TO proposed', async () => {
    const { owner, productId, domain } = await fixture();
    const res = await run(owner, productId);
    expect(res.statusCode, res.body).toBe(200);
    const g = await graph(productId);
    expect(g.assets.map((a) => [a.asset_type, a.name])).toEqual([
      ['host', 'vps-1'],
      ['service', 'PostgreSQL'],
      ['service', 'Redis'],
      ['website', domain],
    ]);
    expect(g.edges).toEqual([
      { type: 'HOSTS', verification: 'verified', source: 'vps-1', target: 'PostgreSQL', confidence: '0.95' },
      { type: 'HOSTS', verification: 'verified', source: 'vps-1', target: 'Redis', confidence: '0.95' },
      { type: 'ROUTES_TO', verification: 'proposed', source: domain, target: 'vps-1', confidence: '0.80' },
    ]);
    // A second run changes nothing.
    await run(owner, productId);
    const again = await graph(productId);
    expect(again.assets).toHaveLength(4);
    expect(again.edges).toHaveLength(3);
  });

  it('adds private databases and links them to the host by IP', async () => {
    const { owner, productId, environmentId } = await fixture();
    const worker = await enrolledAgent(
      t,
      owner,
      environmentId,
      { hostname: 'worker-1', machineId: randomUUID() },
      'private_worker',
    );
    const created = await t.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${owner.orgId}/connections`,
      headers: headers(owner.cookie),
      payload: {
        provider: 'postgres',
        displayName: 'Orders DB',
        executionLocation: 'private',
        config: {
          workerAgentId: worker.agentId,
          secretRef: 'orders',
          host: '203.0.113.7',
          port: 5432,
          database: 'orders',
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    await sql(
      `INSERT INTO connection_resource_scopes (id, organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, $3, 'orders', 'database', 'Orders DB', $4)`,
      [randomUUID(), owner.orgId, created.json().id, productId],
    );
    await run(owner, productId);
    const g = await graph(productId);
    expect(g.assets.map((a) => [a.asset_type, a.name])).toEqual(
      expect.arrayContaining([
        ['database', 'Orders DB'],
        ['worker', 'worker-1'],
      ]),
    );
    expect(g.edges).toContainEqual({
      type: 'DEPLOYED_ON',
      verification: 'proposed',
      source: 'Orders DB',
      target: 'vps-1',
      confidence: '0.80',
    });
  });

  it('turns connector inventory into a domain, a repository, and a monitored service on the agent host (M7, TC-06-06)', async () => {
    const { owner, productId } = await fixture();
    const conn = async (provider: string) => {
      const id = randomUUID();
      await sql(
        `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, updated_at)
         VALUES ($1, $2, $3, $3, 'connected', 'cloud', now())`,
        [id, owner.orgId, provider],
      );
      return id;
    };
    const item = (connectionId: string, type: string, externalId: string, name: string, attributes: object) =>
      sql(
        `INSERT INTO connection_inventory (organization_id, connection_id, resource_type, external_id, name, attributes) VALUES ($1, $2, $3, $4, $5, $6)`,
        [owner.orgId, connectionId, type, externalId, name, JSON.stringify(attributes)],
      );
    const scope = (connectionId: string, type: string, externalId: string, name: string) =>
      sql(
        `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [owner.orgId, connectionId, externalId, type, name, productId],
      );
    const cf = await conn('cloudflare');
    await item(cf, 'cloudflare_zone', 'zone-1', 'firemaps.example', {
      name: 'firemaps.example',
      status: 'active',
    });
    await item(cf, 'dns_record', 'rec-1', 'api.firemaps.example', {
      zoneId: 'zone-1',
      type: 'A',
      name: 'api.firemaps.example',
      content: '203.0.113.7',
      proxied: false,
    });
    await item(cf, 'cloudflare_zone', 'zone-2', 'other.example', { name: 'other.example' });
    await scope(cf, 'cloudflare_zone', 'zone-1', 'firemaps.example');
    const gh = await conn('github');
    await item(gh, 'github_repository', '101', 'acme/shop', {
      name: 'acme/shop',
      fullName: 'acme/shop',
      defaultBranch: 'main',
    });
    await scope(gh, 'github_repository', '101', 'acme/shop');
    const prom = await conn('prometheus');
    await item(prom, 'prometheus_target', 'node|203.0.113.7:9100', '203.0.113.7:9100', {
      instance: '203.0.113.7:9100',
      job: 'node',
      ip: '203.0.113.7',
      health: 'up',
    });
    await item(prom, 'prometheus_server', 'server', 'https://prom.example.com', {
      name: 'https://prom.example.com',
    });
    await scope(prom, 'prometheus_server', 'server', 'Prometheus');

    expect((await run(owner, productId)).statusCode).toBe(200);
    const g = await graph(productId);
    const names = g.assets.map((a) => [a.asset_type, a.name]);
    expect(names).toEqual(
      expect.arrayContaining([
        ['domain', 'firemaps.example'],
        ['repository', 'acme/shop'],
        ['service', 'node'],
      ]),
    );
    expect(names).not.toContainEqual(['domain', 'other.example']); // not scoped to this product
    // The Prometheus target is the agent host (same IP), not a second host.
    expect(g.assets.filter((a) => a.asset_type === 'host')).toHaveLength(1);
    expect(g.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'HOSTS', source: 'vps-1', target: 'node' }),
        expect.objectContaining({ type: 'ROUTES_TO', source: 'firemaps.example', target: 'vps-1' }),
      ]),
    );
  });

  it('drifts a verified route when DNS moves to a new host and proposes the new one (Review Focus #4)', async () => {
    const { owner, productId, environmentId, domain } = await fixture();
    await run(owner, productId);
    await sql(
      `UPDATE asset_relationships SET verification = 'verified' WHERE relationship_type = 'ROUTES_TO' AND source_asset_id IN (SELECT asset_id FROM product_assets WHERE product_id = $1)`,
      [productId],
    );
    const next = await enrolledAgent(t, owner, environmentId, { hostname: 'vps-2', machineId: randomUUID() });
    await heartbeat(next, '198.51.100.9');
    dns.set(domain, ['198.51.100.9']);
    await run(owner, productId);
    const routes = (await graph(productId)).edges.filter((e) => e.type === 'ROUTES_TO');
    expect(routes).toEqual([
      { type: 'ROUTES_TO', verification: 'drifted', source: domain, target: 'vps-1', confidence: '0.80' },
      { type: 'ROUTES_TO', verification: 'proposed', source: domain, target: 'vps-2', confidence: '0.80' },
    ]);
  });

  it('runs after an agent posts its inventory, and only for product managers on demand', async () => {
    const { productId, owner } = await fixture();
    // The inventory post in fixture() triggered a background run.
    let n = 0;
    for (let i = 0; i < 50 && n === 0; i++) {
      n = (
        await sql<{ n: number }>(`SELECT count(*)::int AS n FROM discovery_runs WHERE product_id = $1`, [
          productId,
        ])
      )[0]!.n;
      if (!n) await new Promise((r) => setTimeout(r, 100));
    }
    expect(n).toBeGreaterThan(0);
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids) VALUES ($1, $2, $3, 'viewer', true, '{}')`,
      [randomUUID(), owner.orgId, u!.id],
    );
    const viewer = await login(t, email);
    expect((await run({ ...owner, cookie: viewer }, productId)).statusCode).toBe(404);
  });
});
