import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnv, asAgent, enrolledAgent, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, login, ownerWithOrg, signUpAndVerify, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

const INTERNAL = 'internal-token-for-retained-logs-test';

/** A stand-in VictoriaLogs query endpoint that records each request. */
const seen: Array<{ url: URL; accountId?: string; projectId?: string }> = [];
const vlogs: Server = createServer((req, res) => {
  seen.push({
    url: new URL(req.url ?? '/', 'http://x'),
    accountId: req.headers.accountid as string | undefined,
    projectId: req.headers.projectid as string | undefined,
  });
  res.setHeader('content-type', 'application/stream+json');
  res.end(
    [
      JSON.stringify({
        _time: '2026-10-25T01:00:00Z',
        _msg: 'GET /orders 500 password=[REDACTED]',
        agent_id: 'a-1',
        service: 'nginx',
        level: 'error',
      }),
      JSON.stringify({
        _time: '2026-10-25T00:59:00Z',
        _msg: 'ready',
        agent_id: 'a-1',
        service: 'redis',
        level: 'info',
      }),
    ].join('\n') + '\n',
  );
});

let t: TestApp;
let off: TestApp;

beforeAll(async () => {
  const url = await new Promise<string>((r) =>
    vlogs.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(vlogs.address() as { port: number }).port}`)),
  );
  const env = await agentEnv();
  t = await createTestApp({ env: { ...env, INTERNAL_TOKEN: INTERNAL, VLOGS_URL: url } });
  off = await createTestApp({ env });
});

afterAll(async () => {
  await Promise.all([t?.close(), off?.close()]);
  await new Promise((r) => vlogs.close(r));
});

const call = (app: TestApp, cookie: string, method: 'GET' | 'PATCH', url: string, payload?: object) =>
  app.app.inject({
    method,
    url,
    headers: payload ? headers(cookie) : { cookie },
    ...(payload ? { payload } : {}),
  });

async function agentWithRedis(app: TestApp, owner: Owner) {
  const { environmentId } = await environmentFor(app, owner);
  const agent = await enrolledAgent(app, owner, environmentId);
  await sql(
    `INSERT INTO agent_pack_assignments (organization_id, agent_id, pack_id, settings, status, policy_version, updated_at)
     VALUES ($1, $2, 'redis', '{"endpoint":"127.0.0.1:6379"}', 'applied', 1, now())`,
    [owner.orgId, agent.agentId],
  );
  const [p] = await sql<{ product_id: string }>(`SELECT product_id FROM agents WHERE id = $1`, [
    agent.agentId,
  ]);
  return { agent, productId: p!.product_id };
}

describe('retained logs (M18.1, UC-12-04)', () => {
  it('a pack opts in; the agent config carries it and the gateway learns the tenant AccountID', async () => {
    const owner = await ownerWithOrg(t);
    const { agent } = await agentWithRedis(t, owner);
    const res = await call(
      t,
      owner.cookie,
      'PATCH',
      `/api/v1/agents/${agent.agentId}/packs/redis/retained-logs`,
      { enabled: true },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ packId: 'redis', retainLogs: true, status: 'pending' });
    const cfg = await t.app.inject({ method: 'GET', url: '/agent/v1/config', ...asAgent(agent.fingerprint) });
    expect(cfg.json().packs).toEqual([expect.objectContaining({ packId: 'redis', retainLogs: true })]);
    const [org] = await sql<{ logs_account_id: number }>(
      `SELECT logs_account_id FROM organizations WHERE id = $1`,
      [owner.orgId],
    );
    const resolved = await t.app.inject({
      method: 'GET',
      url: `/internal/agents/by-fingerprint/${agent.fingerprint}`,
      headers: { 'x-internal-token': INTERNAL },
    });
    expect(resolved.json()).toMatchObject({
      organizationId: owner.orgId,
      logsAccountId: org!.logs_account_id,
    });
    const [audit] = await sql(
      `SELECT 1 FROM audit_logs WHERE organization_id = $1 AND action = 'pack.retained_logs'`,
      [owner.orgId],
    );
    expect(audit).toBeTruthy();
  });

  it('is unavailable when the platform has no log storage', async () => {
    const owner = await ownerWithOrg(off);
    const { agent, productId } = await agentWithRedis(off, owner);
    const res = await call(
      off,
      owner.cookie,
      'PATCH',
      `/api/v1/agents/${agent.agentId}/packs/redis/retained-logs`,
      { enabled: true },
    );
    expect(res.json().code).toBe('retained_logs_unavailable');
    expect(
      (await call(off, owner.cookie, 'GET', `/api/v1/products/${productId}/logs/search?query=error`)).json()
        .code,
    ).toBe('retained_logs_unavailable');
  });

  it('TC-12-09: search always runs as the caller’s tenant and product', async () => {
    const owner = await ownerWithOrg(t);
    const { agent, productId } = await agentWithRedis(t, owner);
    const [org] = await sql<{ logs_account_id: number }>(
      `SELECT logs_account_id FROM organizations WHERE id = $1`,
      [owner.orgId],
    );
    const res = await call(
      t,
      owner.cookie,
      'GET',
      `/api/v1/products/${productId}/logs/search?query=${encodeURIComponent('error OR tenant_id:other')}&range=24h&agentId=${agent.agentId}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().lines).toEqual([
      {
        time: '2026-10-25T01:00:00Z',
        message: 'GET /orders 500 password=[REDACTED]',
        agentId: 'a-1',
        service: 'nginx',
        level: 'error',
      },
      { time: '2026-10-25T00:59:00Z', message: 'ready', agentId: 'a-1', service: 'redis', level: 'info' },
    ]);
    const last = seen.at(-1)!;
    expect(last.url.pathname).toBe('/select/logsql/query');
    expect(last.accountId).toBe(String(org!.logs_account_id));
    expect(last.projectId).toBe('0');
    expect(last.url.searchParams.get('query')).toBe(
      `product_id:="${productId}" agent_id:="${agent.agentId}" (error OR tenant_id:other) | sort by (_time desc) | limit 500`,
    );
    expect(
      (
        await call(
          t,
          owner.cookie,
          'GET',
          `/api/v1/products/${productId}/logs/search?query=${encodeURIComponent('x | delete')}`,
        )
      ).statusCode,
    ).toBe(400);
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`,
      [randomUUID(), owner.orgId, u!.id],
    );
    expect(
      (await call(t, await login(t, email), 'GET', `/api/v1/products/${productId}/logs/search?query=x`))
        .statusCode,
    ).toBe(404);
  });
});
