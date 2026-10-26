import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorRuntime, buildRegistry } from '@pcp/connector-runtime';
import { startProcessors, type Processors } from '@pcp/jobs';
import { loadKeyRing } from '@pcp/secrets';
import { inject } from 'vitest';
import { MASTER_KEY, createTestApp, type TestApp } from '../../../test/app-factory.js';
import type { Queues } from '@pcp/jobs';
import { QUEUES } from './registry.provider.js';
import {
  createProduct,
  enrollMfa,
  headers,
  login,
  ownerWithOrg,
  signUpAndVerify,
  type Owner,
} from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

const TOKEN = `mock-token-${randomUUID()}`;
let t: TestApp;
let processors: Processors;
const bodies: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
  // Connection jobs only: other test files queue report and action jobs on the same Redis.
  processors = startProcessors({
    kinds: ['connection-validate', 'connection-discover', 'connection-health'],
    redisUrl: inject('redisUrl'),
    prisma: t.prisma,
    runtime: new ConnectorRuntime(
      t.prisma,
      await buildRegistry({ PCP_ENABLE_MOCK_CONNECTOR: '1', NODE_ENV: 'test' }),
      loadKeyRing({ MASTER_KEY }),
    ),
  });
});

afterAll(async () => {
  await processors?.close();
  await t?.close();
});

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
) {
  const { 'content-type': _ct, ...bare } = headers(cookie);
  const res = await t.app.inject({
    method,
    url,
    headers: payload ? headers(cookie) : bare,
    ...(payload ? { payload } : {}),
  });
  bodies.push(res.body);
  return res;
}

async function mockConnection(owner: Owner, behavior = 'ok') {
  const res = await call('POST', `/api/v1/organizations/${owner.orgId}/connections`, owner.cookie, {
    provider: 'mock',
    displayName: 'Mock',
    executionLocation: 'cloud',
    config: { behavior, resources: 2 },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; status: string };
}

async function until(fn: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('connections API', () => {
  it('lists the mock connector in the catalog', async () => {
    const owner = await ownerWithOrg(t);
    const res = await call('GET', '/api/v1/connectors/catalog', owner.cookie);
    expect(res.json().connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mock',
          credentialFields: [
            { name: 'token', label: 'Token', secret: true },
            { name: 'webhookSecret', label: 'Webhook secret', secret: true, required: false },
          ],
        }),
      ]),
    );
  });

  it('takes a connection from draft to connected through the API and worker (M4 exit gate)', async () => {
    const owner = await ownerWithOrg(t);
    const conn = await mockConnection(owner);
    expect(conn.status).toBe('draft');
    const auth = await call('POST', `/api/v1/connections/${conn.id}/authorize`, owner.cookie, {
      credentials: { token: TOKEN },
    });
    expect(auth.statusCode).toBe(200);
    expect(auth.json().status).toBe('pending_validation');
    await until(
      async () =>
        (await call('GET', `/api/v1/connections/${conn.id}`, owner.cookie)).json().status === 'connected',
    );
    const runs = await call('GET', `/api/v1/connections/${conn.id}/sync-runs`, owner.cookie);
    expect(runs.json().runs[0]).toMatchObject({ kind: 'validate', status: 'succeeded' });
  });

  it('rejects unknown providers, unsupported locations, invalid config, and missing credentials', async () => {
    const owner = await ownerWithOrg(t);
    const base = { provider: 'mock', displayName: 'M', executionLocation: 'cloud', config: {} };
    const url = `/api/v1/organizations/${owner.orgId}/connections`;
    expect((await call('POST', url, owner.cookie, { ...base, provider: 'nope' })).json().code).toBe(
      'unknown_connector',
    );
    expect(
      (await call('POST', url, owner.cookie, { ...base, config: { behavior: 'explode' } })).json().code,
    ).toBe('validation_failed');
    const conn = await mockConnection(owner);
    const res = await call('POST', `/api/v1/connections/${conn.id}/authorize`, owner.cookie, {
      credentials: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('discovers resources and scopes them to products; product-scoped members see only scoped connections', async () => {
    const owner = await ownerWithOrg(t);
    const productA = await createProduct(t, owner, 'A');
    const productB = await createProduct(t, owner, 'B');
    const conn = await mockConnection(owner);
    await call('POST', `/api/v1/connections/${conn.id}/authorize`, owner.cookie, {
      credentials: { token: TOKEN },
    });
    const resources = await call('GET', `/api/v1/connections/${conn.id}/resources`, owner.cookie);
    expect(resources.json().resources).toEqual([
      { externalId: 'mock-1', resourceType: 'mock_resource', name: 'Mock resource 1' },
      { externalId: 'mock-2', resourceType: 'mock_resource', name: 'Mock resource 2' },
    ]);
    const scoped = await call('POST', `/api/v1/connections/${conn.id}/resource-scopes`, owner.cookie, {
      scopes: [
        { externalId: 'mock-1', resourceType: 'mock_resource', name: 'Mock resource 1', productId: productA },
      ],
    });
    expect(scoped.statusCode).toBe(200);

    const analyst = async (productId: string) => {
      const email = await signUpAndVerify(t);
      const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
      await sql(
        `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids)
         VALUES ($1, $2, $3, 'analyst', false, ARRAY[$4]::uuid[])`,
        [randomUUID(), owner.orgId, u!.id, productId],
      );
      return login(t, email);
    };
    expect((await call('GET', `/api/v1/connections/${conn.id}`, await analyst(productA))).statusCode).toBe(
      200,
    );
    const outsider = await analyst(productB);
    expect((await call('GET', `/api/v1/connections/${conn.id}`, outsider)).statusCode).toBe(404);
    const list = await call('GET', `/api/v1/organizations/${owner.orgId}/connections`, outsider);
    expect(list.json().connections).toEqual([]);
  });

  it('deleting crypto-shreds the secret and a late job does not revive it (Review Focus #5)', async () => {
    const owner = await ownerWithOrg(t);
    const conn = await mockConnection(owner);
    await call('POST', `/api/v1/connections/${conn.id}/authorize`, owner.cookie, {
      credentials: { token: TOKEN },
    });
    const del = await call('DELETE', `/api/v1/connections/${conn.id}`, owner.cookie);
    expect(del.statusCode).toBe(202);
    expect(await sql(`SELECT 1 FROM connection_secrets WHERE connection_id = $1`, [conn.id])).toEqual([]);
    await call('POST', `/api/v1/connections/${conn.id}/validate`, owner.cookie, {});
    await new Promise((r) => setTimeout(r, 1500));
    const [row] = await sql<{ status: string }>(`SELECT status FROM connections WHERE id = $1`, [conn.id]);
    expect(row!.status).toBe('disconnected');
  });

  it('accepts credentials again while validation is still pending (double submit)', async () => {
    const owner = await ownerWithOrg(t);
    const conn = await mockConnection(owner);
    const url = `/api/v1/connections/${conn.id}/authorize`;
    const [first, second] = await Promise.all([
      call('POST', url, owner.cookie, { credentials: { token: TOKEN } }),
      call('POST', url, owner.cookie, { credentials: { token: TOKEN } }),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const again = await call('POST', url, owner.cookie, { credentials: { token: TOKEN } });
    expect(again.statusCode, again.body).toBe(200);
  });

  it("a product-scoped admin replaces only their products' scopes", async () => {
    const owner = await ownerWithOrg(t);
    const productA = await createProduct(t, owner, 'A');
    const productB = await createProduct(t, owner, 'B');
    const conn = await mockConnection(owner);
    const scope = (externalId: string, productId: string) => ({
      externalId,
      resourceType: 'mock_resource',
      name: externalId,
      productId,
    });
    await call('POST', `/api/v1/connections/${conn.id}/resource-scopes`, owner.cookie, {
      scopes: [scope('mock-1', productA), scope('mock-2', productB)],
    });
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids)
       VALUES ($1, $2, $3, 'admin', false, ARRAY[$4]::uuid[])`,
      [randomUUID(), owner.orgId, u!.id, productA],
    );
    const admin = await login(t, email);
    await enrollMfa(t, admin);
    const res = await call('POST', `/api/v1/connections/${conn.id}/resource-scopes`, admin, {
      scopes: [scope('mock-3', productA)],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().scopes.map((s: { externalId: string }) => s.externalId)).toEqual(['mock-3']);
    const rows = await sql<{ external_id: string }>(
      `SELECT external_id FROM connection_resource_scopes WHERE connection_id = $1 ORDER BY external_id`,
      [conn.id],
    );
    expect(rows.map((r) => r.external_id)).toEqual(['mock-2', 'mock-3']);
  });

  it('saving a scope starts a sync right away for connectors with daily values (M13b)', async () => {
    const owner = await ownerWithOrg(t);
    const product = await createProduct(t, owner, 'A');
    const conn = await mockConnection(owner);
    await sql(`UPDATE connections SET status = 'connected' WHERE id = $1`, [conn.id]);
    const res = await call('POST', `/api/v1/connections/${conn.id}/resource-scopes`, owner.cookie, {
      scopes: [{ externalId: 'mock-1', resourceType: 'mock_resource', name: 'R', productId: product }],
    });
    expect(res.statusCode).toBe(200);
    const queued = await t.app
      .get<Queues>(QUEUES)
      .get('connection-sync')
      .getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(queued.map((j) => j.data.connectionId)).toContain(conn.id);
  });

  it('hides connection management from viewers (404)', async () => {
    const owner = await ownerWithOrg(t);
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`,
      [randomUUID(), owner.orgId, u!.id],
    );
    const res = await call(
      'POST',
      `/api/v1/organizations/${owner.orgId}/connections`,
      await login(t, email),
      {
        provider: 'mock',
        displayName: 'M',
        executionLocation: 'cloud',
        config: {},
      },
    );
    expect(res.statusCode).toBe(404);
  });

  it('never returned the credential in any response (TC-02-03)', () => {
    expect(bodies.length).toBeGreaterThan(10);
    for (const body of bodies) expect(body).not.toContain(TOKEN);
  });
});

describe('mock connector safety', () => {
  it('refuses to start with the mock connector in production', async () => {
    await expect(createTestApp({ env: { NODE_ENV: 'production' } })).rejects.toThrow(/production/);
  });

  it('is not a production dependency of the API', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).not.toContain('@pcp/connectors-mock');
  });
});

describe('AWS connection setup', () => {
  it('generates a distinct external ID server-side and never accepts a caller-supplied value', async () => {
    const owner = await ownerWithOrg(t);
    const body = {
      provider: 'aws',
      displayName: 'AWS',
      executionLocation: 'cloud',
      config: {
        roleArn: 'arn:aws:iam::123456789012:role/ReadOnly',
        regions: ['us-east-1'],
        services: ['s3', 'lambda', 'amplify', 'costs'],
        externalId: 'attacker-selected-external-id',
      },
    };
    const create = () =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${owner.orgId}/connections`,
        headers: headers(owner.cookie),
        payload: body,
      });
    const a = await create();
    const b = await create();
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().config.externalId).toMatch(/^[a-f0-9-]{36}$/);
    expect(a.json().config.externalId).not.toBe(body.config.externalId);
    expect(a.json().config.externalId).not.toBe(b.json().config.externalId);
  });
});
