import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnv, asAgent, enrolledAgent, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, login, ownerWithOrg, signUpAndVerify, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv() });
});

afterAll(async () => {
  await t?.close();
});

// Shape of an ECIES payload (32-byte ephemeral key || 12-byte nonce || ciphertext+tag); the API never opens it.
const SEALED = randomBytes(32 + 12 + 48).toString('base64');

const inventory = {
  collectedAt: new Date().toISOString(),
  services: [
    {
      pack: 'redis',
      name: 'Redis',
      ports: [{ address: '127.0.0.1', port: 6379 }],
      processCount: 1,
      evidence: ['process redis-server (pid 1)'],
    },
    {
      pack: 'postgresql',
      name: 'PostgreSQL',
      ports: [{ address: '0.0.0.0', port: 5432 }],
      processCount: 2,
      evidence: [],
    },
  ],
  listeners: [
    { address: '127.0.0.1', port: 6379 },
    { address: '0.0.0.0', port: 5432 },
  ],
  warnings: [{ kind: 'exposed_service', pack: 'postgresql', address: '0.0.0.0', port: 5432 }],
};

async function setup() {
  const owner = await ownerWithOrg(t);
  const env = await environmentFor(t, owner);
  const agent = await enrolledAgent(t, owner, env.environmentId);
  return { owner, ...env, agent };
}

type Payload = Record<string, unknown>;

// Requests without a body drop the JSON content type (Fastify rejects an empty JSON body).
const user = (cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Payload) => {
  const { 'content-type': _, ...rest } = headers(cookie);
  return payload === undefined
    ? t.app.inject({ method, url, headers: rest })
    : t.app.inject({ method, url, headers: headers(cookie), payload });
};

const agentReq = (fingerprint: string, method: 'GET' | 'POST', url: string, payload?: Payload) =>
  t.app.inject({ method, url, ...asAgent(fingerprint), ...(payload === undefined ? {} : { payload }) });

const enable = (owner: Owner, agentId: string, body: Record<string, unknown>) =>
  user(owner.cookie, 'POST', `/api/v1/agents/${agentId}/packs`, body);

describe('pack catalog', () => {
  it('lists the packs with their settings and credential fields', async () => {
    const { owner } = await setup();
    const res = await user(owner.cookie, 'GET', '/api/v1/monitoring-packs');
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().packs as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual([
      'redis',
      'postgresql',
      'mysql',
      'mongodb',
      'kafka',
      'redis-exporter',
      'kafka-exporter',
      'nginx',
      'nodejs',
    ]);
    const pg = res.json().packs.find((p: { id: string }) => p.id === 'postgresql');
    expect(pg).toMatchObject({ name: 'PostgreSQL', defaultEndpoint: '127.0.0.1:5432' });
    expect(pg.credentialFields.map((f: { name: string }) => f.name)).toEqual(['username', 'password']);
  });

  it('needs a session', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/monitoring-packs' })).statusCode).toBe(401);
  });
});

describe('inventory (WB-11 discovery)', () => {
  it('stores the latest inventory and suggests detected packs that are not enabled', async () => {
    const { owner, agent } = await setup();
    const empty = await user(owner.cookie, 'GET', `/api/v1/agents/${agent.agentId}/inventory`);
    expect(empty.json()).toEqual({ inventory: null, suggestedPacks: [] });

    const post = await agentReq(agent.fingerprint, 'POST', '/agent/v1/inventory', inventory);
    expect(post.statusCode, post.body).toBe(202);
    await agentReq(agent.fingerprint, 'POST', '/agent/v1/inventory', inventory); // replaces, not appends
    await enable(owner, agent.agentId, { packId: 'redis', settings: { endpoint: '127.0.0.1:6379' } });

    const res = await user(owner.cookie, 'GET', `/api/v1/agents/${agent.agentId}/inventory`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().inventory).toMatchObject({
      services: inventory.services,
      warnings: inventory.warnings,
      listeners: inventory.listeners,
    });
    expect(res.json().suggestedPacks).toEqual(['postgresql']);
  });

  it('rejects a malformed inventory and one with tenant identifiers', async () => {
    const { agent } = await setup();
    expect(
      (await agentReq(agent.fingerprint, 'POST', '/agent/v1/inventory', { ...inventory, services: 'x' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await agentReq(agent.fingerprint, 'POST', '/agent/v1/inventory', {
          ...inventory,
          organizationId: randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('pack assignments and the configuration channel (Review Focus #1)', () => {
  it('enables a pack, delivers ciphertext once, and deletes it after an applied ack', async () => {
    const { owner, agent } = await setup();
    const before = await user(owner.cookie, 'GET', `/api/v1/agents/${agent.agentId}`);
    expect(before.json().x25519PublicKey).toBe(Buffer.alloc(32, 9).toString('base64'));
    expect(before.json().policyVersion).toBe(1);

    const res = await enable(owner, agent.agentId, {
      packId: 'postgresql',
      settings: { endpoint: '127.0.0.1:5432' },
      sealedCredentials: SEALED,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      packId: 'postgresql',
      status: 'pending',
      settings: { endpoint: '127.0.0.1:5432' },
    });
    expect(res.body).not.toContain(SEALED);

    const hb = await agentReq(agent.fingerprint, 'POST', '/agent/v1/heartbeat', {
      protocolVersion: '1.0',
      sequence: Date.now(),
      agentVersion: '1.0.0',
      policyVersion: 1,
      capabilities: [],
      health: 'ok',
      queueDepth: 0,
      sentAt: new Date().toISOString(),
    });
    expect(hb.json().policyVersion).toBe(2);

    const config = await agentReq(agent.fingerprint, 'GET', '/agent/v1/config');
    expect(config.statusCode, config.body).toBe(200);
    expect(config.json()).toEqual({
      policyVersion: 2,
      packs: [{ packId: 'postgresql', settings: { endpoint: '127.0.0.1:5432' }, sealedCredentials: SEALED }],
    });

    const ack = await agentReq(agent.fingerprint, 'POST', '/agent/v1/config/ack', {
      policyVersion: 2,
      results: [{ packId: 'postgresql', status: 'applied' }],
    });
    expect(ack.statusCode, ack.body).toBe(204);

    const [row] = await sql<{ sealed_credentials: string | null; status: string; applied_at: Date | null }>(
      `SELECT sealed_credentials, status, applied_at FROM agent_pack_assignments WHERE agent_id = $1`,
      [agent.agentId],
    );
    expect(row).toMatchObject({ sealed_credentials: null, status: 'applied' });
    expect(row!.applied_at).not.toBeNull();

    const again = await agentReq(agent.fingerprint, 'GET', '/agent/v1/config');
    expect(again.json().packs).toEqual([{ packId: 'postgresql', settings: { endpoint: '127.0.0.1:5432' } }]);
    const list = await user(owner.cookie, 'GET', `/api/v1/agents/${agent.agentId}/packs`);
    expect(list.json().packs).toEqual([
      expect.objectContaining({ packId: 'postgresql', status: 'applied', statusMessage: null }),
    ]);
    for (const body of [again.body, list.body]) expect(body).not.toContain(SEALED);
    const audit = await sql<{ metadata: unknown }>(
      `SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action LIKE 'pack.%'`,
      [owner.orgId],
    );
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit)).not.toContain(SEALED);
  });

  it('keeps the ciphertext when the ack is for an older policy version', async () => {
    const { owner, agent } = await setup();
    await enable(owner, agent.agentId, { packId: 'redis', settings: { endpoint: '127.0.0.1:6379' } });
    await enable(owner, agent.agentId, {
      packId: 'redis',
      settings: { endpoint: '127.0.0.1:6379' },
      sealedCredentials: SEALED,
    });
    await agentReq(agent.fingerprint, 'POST', '/agent/v1/config/ack', {
      policyVersion: 2,
      results: [{ packId: 'redis', status: 'applied' }],
    });
    const [row] = await sql<{ sealed_credentials: string | null; status: string }>(
      `SELECT sealed_credentials, status FROM agent_pack_assignments WHERE agent_id = $1`,
      [agent.agentId],
    );
    expect(row).toEqual({ sealed_credentials: SEALED, status: 'pending' });
  });

  it('records a failed apply with its message', async () => {
    const { owner, agent } = await setup();
    await enable(owner, agent.agentId, {
      packId: 'mysql',
      settings: { endpoint: '127.0.0.1:3306' },
      sealedCredentials: SEALED,
    });
    await agentReq(agent.fingerprint, 'POST', '/agent/v1/config/ack', {
      policyVersion: 2,
      results: [{ packId: 'mysql', status: 'failed', message: 'receivers::mysql: invalid endpoint' }],
    });
    const list = await user(owner.cookie, 'GET', `/api/v1/agents/${agent.agentId}/packs`);
    expect(list.json().packs[0]).toMatchObject({
      status: 'failed',
      statusMessage: 'receivers::mysql: invalid endpoint',
    });
  });

  it('disables a pack: removing until the agent acknowledges, then gone', async () => {
    const { owner, agent } = await setup();
    await enable(owner, agent.agentId, {
      packId: 'nginx',
      settings: { endpoint: 'http://127.0.0.1/nginx_status' },
    });
    const del = await user(owner.cookie, 'DELETE', `/api/v1/agents/${agent.agentId}/packs/nginx`);
    expect(del.statusCode, del.body).toBe(202);
    expect(
      (await user(owner.cookie, 'GET', `/api/v1/agents/${agent.agentId}/packs`)).json().packs[0].status,
    ).toBe('removing');
    const config = await agentReq(agent.fingerprint, 'GET', '/agent/v1/config');
    expect(config.json()).toEqual({ policyVersion: 3, packs: [] });
    await agentReq(agent.fingerprint, 'POST', '/agent/v1/config/ack', { policyVersion: 3, results: [] });
    expect((await user(owner.cookie, 'GET', `/api/v1/agents/${agent.agentId}/packs`)).json().packs).toEqual(
      [],
    );
    expect(
      (await user(owner.cookie, 'DELETE', `/api/v1/agents/${agent.agentId}/packs/nginx`)).statusCode,
    ).toBe(404);
  });

  it('validates the pack, its settings, and the ciphertext size', async () => {
    const { owner, agent } = await setup();
    const bad = async (body: Record<string, unknown>) =>
      (await enable(owner, agent.agentId, body)).statusCode;
    expect(await bad({ packId: 'docker', settings: {} })).toBe(400);
    expect(await bad({ packId: 'redis', settings: { endpoint: 'not a host' } })).toBe(400);
    expect(await bad({ packId: 'redis', settings: { endpoint: '127.0.0.1:6379', extra: 1 } })).toBe(400);
    expect(
      await bad({
        packId: 'redis',
        settings: { endpoint: '127.0.0.1:6379' },
        sealedCredentials: 'x'.repeat(5000),
      }),
    ).toBe(400);
    expect(
      await bad({
        packId: 'redis',
        settings: { endpoint: '127.0.0.1:6379' },
        sealedCredentials: 'not base64!',
      }),
    ).toBe(400);
    expect(await bad({ packId: 'nodejs', settings: {} })).toBe(201);
  });
});

describe('pack permissions (Review Focus #5)', () => {
  it('hides other products and tenants, and refuses members without pack.manage', async () => {
    const { owner, productId, agent } = await setup();
    const other = await environmentFor(t, owner);
    const otherAgent = await enrolledAgent(t, owner, other.environmentId);
    const member = async (role: string) => {
      const email = await signUpAndVerify(t);
      const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
      await sql(
        `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids)
         VALUES ($1, $2, $3, $4, false, ARRAY[$5]::uuid[])`,
        [randomUUID(), owner.orgId, u!.id, role, productId],
      );
      return login(t, email);
    };
    const operator = await member('operator');
    const viewer = await member('viewer');
    const body = { packId: 'redis', settings: { endpoint: '127.0.0.1:6379' } };
    expect(
      (await user(operator, 'POST', `/api/v1/agents/${otherAgent.agentId}/packs`, body)).statusCode,
    ).toBe(404);
    expect((await user(operator, 'GET', `/api/v1/agents/${otherAgent.agentId}/inventory`)).statusCode).toBe(
      404,
    );
    expect((await user(viewer, 'POST', `/api/v1/agents/${agent.agentId}/packs`, body)).statusCode).toBe(404);
    expect((await user(viewer, 'GET', `/api/v1/agents/${agent.agentId}/packs`)).statusCode).toBe(200);
    expect((await user(operator, 'POST', `/api/v1/agents/${agent.agentId}/packs`, body)).statusCode).toBe(
      201,
    );
    const stranger = await ownerWithOrg(t);
    expect((await user(stranger.cookie, 'GET', `/api/v1/agents/${agent.agentId}/packs`)).statusCode).toBe(
      404,
    );
  });

  it('refuses packs on a revoked agent', async () => {
    const { owner, agent } = await setup();
    await user(owner.cookie, 'POST', `/api/v1/agents/${agent.agentId}/revoke`);
    const res = await enable(owner, agent.agentId, {
      packId: 'redis',
      settings: { endpoint: '127.0.0.1:6379' },
    });
    expect(res.statusCode).toBe(409);
  });
});
