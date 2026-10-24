import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { enrollMfa, headers, login, ownerWithOrg, signUpAndVerify } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

const ZONE = '023e105f4ecef8ad9ca31a8372d0c353';
let t: TestApp;
let cf: Server;
const purges: unknown[] = [];

beforeAll(async () => {
  // A fake Cloudflare API: token verify, one zone, and cache purge.
  cf = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const ok = (result: unknown) => res.end(JSON.stringify({ success: true, errors: [], result }));
      if (req.url?.startsWith('/user/tokens/verify')) return ok({ status: 'active' });
      if (req.url?.startsWith(`/zones/${ZONE}/purge_cache`)) {
        purges.push(JSON.parse(body));
        return ok({ id: 'purge-1' });
      }
      if (req.url?.startsWith('/zones'))
        return ok([{ id: ZONE, name: 'firemaps.example', status: 'active' }]);
      res.statusCode = 404;
      res.end('{}');
    });
  });
  const port = await new Promise<number>((r) =>
    cf.listen(0, '127.0.0.1', () => r((cf.address() as { port: number }).port)),
  );
  t = await createTestApp({
    env: { PCP_CLOUDFLARE_API_URL: `http://127.0.0.1:${port}`, PCP_ALLOW_TEST_PROVIDERS: '1' },
  });
});

afterAll(async () => {
  await t?.close();
  await new Promise((r) => cf.close(r));
});

type Body = Record<string, unknown>;
const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Body) =>
  payload === undefined
    ? t.app.inject({ method, url, headers: { cookie } })
    : t.app.inject({ method, url, headers: headers(cookie), payload });

describe('provider actions through connections (M16 + M7)', () => {
  it('purges Cloudflare cache URLs after approval and records the verified result', async () => {
    const owner = await ownerWithOrg(t);
    const { productId, environmentId } = await environmentFor(t, owner);
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role, all_products) VALUES ($1, $2, $3, 'admin', true)`,
      [randomUUID(), owner.orgId, u!.id],
    );
    const admin = await login(t, email);
    await enrollMfa(t, admin);

    const conn = (
      await call(owner.cookie, 'POST', `/api/v1/organizations/${owner.orgId}/connections`, {
        provider: 'cloudflare',
        displayName: 'Cloudflare',
        executionLocation: 'cloud',
        config: {},
      })
    ).json();
    expect(
      (
        await call(owner.cookie, 'POST', `/api/v1/connections/${conn.id}/authorize`, {
          credentials: { apiToken: 'cf-token' },
        })
      ).statusCode,
    ).toBeLessThan(300);
    await sql(`UPDATE connections SET status = 'connected' WHERE id = $1`, [conn.id]);
    const scoped = await call(owner.cookie, 'POST', `/api/v1/connections/${conn.id}/resource-scopes`, {
      scopes: [{ externalId: ZONE, resourceType: 'cloudflare_zone', name: 'firemaps.example', productId }],
    });
    expect(scoped.statusCode, scoped.body).toBeLessThan(300);

    const policies = (await call(owner.cookie, 'GET', `/api/v1/products/${productId}/action-policies`)).json()
      .policies;
    expect(policies.find((p: Body) => p.capability === 'cloudflare.purge_cache')).toMatchObject({
      available: true,
    });
    await call(owner.cookie, 'PUT', `/api/v1/products/${productId}/action-policies/cloudflare.purge_cache`, {
      environmentId,
      enabled: true,
      approverRoles: ['owner', 'admin'],
      requireApproval: true,
      settings: { zones: [ZONE] },
    });
    const req = await call(owner.cookie, 'POST', '/api/v1/actions/proposals', {
      productId,
      environmentId,
      capability: 'cloudflare.purge_cache',
      target: { connectionId: conn.id, zoneId: ZONE },
      params: { urls: ['https://firemaps.example/app.css'] },
      idempotencyKey: randomUUID(),
      reason: 'stale CSS',
    });
    expect(req.statusCode, req.body).toBe(201);
    expect(req.json()).toMatchObject({ status: 'pending_approval' });
    expect(req.json().impact.summary).toContain('firemaps.example');

    const approved = await call(admin, 'POST', `/api/v1/actions/${req.json().id}/approve`, {});
    expect(approved.statusCode, approved.body).toBe(200);
    let done: Body = {};
    for (let i = 0; i < 50; i++) {
      done = (await call(owner.cookie, 'GET', `/api/v1/actions/${req.json().id}`)).json();
      if (done.status === 'succeeded' || done.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(done).toMatchObject({ status: 'succeeded' });
    expect((done.executions as Body[])[0]).toMatchObject({
      location: 'platform',
      adapter: 'cloudflare.purge_cache',
      verification: { apiSuccess: true },
    });
    expect(purges).toEqual([{ files: ['https://firemaps.example/app.css'] }]);
  });

  it('still answers connection_required without a matching connection', async () => {
    const owner = await ownerWithOrg(t);
    const { productId, environmentId } = await environmentFor(t, owner);
    const res = await call(owner.cookie, 'POST', '/api/v1/actions/proposals', {
      productId,
      environmentId,
      capability: 'cloudflare.purge_cache',
      target: { connectionId: randomUUID(), zoneId: ZONE },
      params: { everything: true },
      idempotencyKey: randomUUID(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('connection_required');
  });
});
