import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnv, asAgent, enrolledAgent, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, login, ownerWithOrg, signUpAndVerify } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;
const now = new Date();

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv(), clock: () => now });
});

afterAll(async () => {
  await t?.close();
});

const heartbeat = (fingerprint: string, overrides: Record<string, unknown> = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/agent/v1/heartbeat',
    ...asAgent(fingerprint),
    payload: {
      protocolVersion: '1.0',
      sequence: 1,
      agentVersion: '1.0.1',
      policyVersion: 1,
      capabilities: ['host.health'],
      health: 'ok',
      queueDepth: 0,
      sentAt: now.toISOString(),
      ...overrides,
    },
  });

describe('heartbeats (WB-03 UC-03-03)', () => {
  it('records a heartbeat and ignores an older sequence', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const agent = await enrolledAgent(t, owner, environmentId);
    const first = await heartbeat(agent.fingerprint, { sequence: 5 });
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toEqual({ accepted: true, policyVersion: 1 });
    expect((await heartbeat(agent.fingerprint, { sequence: 4 })).json().accepted).toBe(false);
    expect((await heartbeat(agent.fingerprint, { sequence: 5 })).json().accepted).toBe(false);
    const [row] = await sql<{ last_sequence: string; agent_version: string }>(
      `SELECT last_sequence, agent_version FROM agents WHERE id = $1`,
      [agent.agentId],
    );
    expect(row).toEqual({ last_sequence: '5', agent_version: '1.0.1' });
    const [count] = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM agent_heartbeats WHERE agent_id = $1`,
      [agent.agentId],
    );
    expect(count!.n).toBe('1');
  });

  it('accepts but flags a heartbeat with a skewed clock', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const agent = await enrolledAgent(t, owner, environmentId);
    const skewed = new Date(now.getTime() + 10 * 60_000).toISOString();
    expect((await heartbeat(agent.fingerprint, { sentAt: skewed })).json().accepted).toBe(true);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.agentId}`,
      headers: headers(owner.cookie),
    });
    expect(res.json().clockSkewSeconds).toBe(600);
  });

  it('rejects malformed heartbeats and tenant identifiers', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const agent = await enrolledAgent(t, owner, environmentId);
    expect((await heartbeat(agent.fingerprint, { sequence: undefined })).statusCode).toBe(400);
    expect((await heartbeat(agent.fingerprint, { organizationId: randomUUID() })).statusCode).toBe(400);
  });
});

describe('fleet (WB-03 §8)', () => {
  it('lists agents with derived status and flags duplicate machine IDs', async () => {
    const owner = await ownerWithOrg(t);
    const { productId, environmentId } = await environmentFor(t, owner);
    const a = await enrolledAgent(t, owner, environmentId, { hostname: 'api-1', machineId: 'cloned' });
    const b = await enrolledAgent(t, owner, environmentId, { hostname: 'api-2', machineId: 'cloned' });
    await enrolledAgent(t, owner, environmentId, { hostname: 'db-1', machineId: 'unique' });
    await heartbeat(a.fingerprint);
    await sql(
      `UPDATE agents SET last_heartbeat_at = now() - interval '10 minutes', created_at = now() - interval '1 hour' WHERE id = $1`,
      [b.agentId],
    );
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/products/${productId}/agents`,
      headers: headers(owner.cookie),
    });
    expect(res.statusCode, res.body).toBe(200);
    const byHost = Object.fromEntries(
      (res.json().agents as Array<{ hostname: string }>).map((x) => [x.hostname, x]),
    );
    expect(byHost['api-1']).toMatchObject({
      status: 'active',
      stale: false,
      duplicateMachineId: true,
      environmentName: 'production',
      agentVersion: '1.0.1',
    });
    expect(byHost['api-2']).toMatchObject({ status: 'degraded', stale: true, duplicateMachineId: true });
    expect(byHost['db-1']).toMatchObject({ duplicateMachineId: false });

    const detail = await t.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${a.agentId}`,
      headers: headers(owner.cookie),
    });
    expect(detail.json()).toMatchObject({
      id: a.agentId,
      capabilities: ['host.health'],
      certificate: { fingerprintSha256: a.fingerprint },
      recentHeartbeats: [expect.objectContaining({ health: 'ok', queueDepth: 0 })],
    });
  });

  it('limits product-scoped members to their products and hides other tenants (Review Focus #5)', async () => {
    const owner = await ownerWithOrg(t);
    const one = await environmentFor(t, owner);
    const two = await environmentFor(t, owner);
    const agentTwo = await enrolledAgent(t, owner, two.environmentId);
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids)
       VALUES ($1, $2, $3, 'analyst', false, ARRAY[$4]::uuid[])`,
      [randomUUID(), owner.orgId, u!.id, one.productId],
    );
    const analyst = await login(t, email);
    const get = (url: string, cookie: string) =>
      t.app.inject({ method: 'GET', url, headers: headers(cookie) });
    expect((await get(`/api/v1/agents/${agentTwo.agentId}`, analyst)).statusCode).toBe(404);
    expect((await get(`/api/v1/products/${two.productId}/agents`, analyst)).statusCode).toBe(404);
    expect((await get(`/api/v1/products/${one.productId}/agents`, analyst)).json().agents).toEqual([]);
    const other = await ownerWithOrg(t);
    expect((await get(`/api/v1/agents/${agentTwo.agentId}`, other.cookie)).statusCode).toBe(404);
  });
});
