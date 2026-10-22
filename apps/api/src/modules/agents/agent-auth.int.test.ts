import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentEnv,
  asAgent,
  enrolledAgent,
  environmentFor,
  type EnrolledAgent,
} from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, ownerWithOrg, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;
let now = Date.now();
let owner: Owner;
let environmentId: string;

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv(), clock: () => new Date(now) });
  owner = await ownerWithOrg(t);
  ({ environmentId } = await environmentFor(t, owner));
});

afterAll(async () => {
  await t?.close();
});

const whoami = (fingerprint: string, from?: string, extra: Record<string, string> = {}) => {
  const a = asAgent(fingerprint, from);
  return t.app.inject({
    method: 'GET',
    url: '/agent/v1/whoami',
    remoteAddress: a.remoteAddress,
    headers: { ...a.headers, ...extra },
  });
};

describe('agent authentication (WB-03 §10, D10)', () => {
  let agent: EnrolledAgent;

  beforeAll(async () => {
    agent = await enrolledAgent(t, owner, environmentId);
  });

  it('accepts the fingerprint forwarded by Caddy', async () => {
    const res = await whoami(agent.fingerprint);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ agentId: agent.agentId });
  });

  it('ignores the header from any other address (TC-03-05)', async () => {
    expect((await whoami(agent.fingerprint, '10.0.0.5')).statusCode).toBe(401);
  });

  it('ignores a forged X-Forwarded-For naming Caddy (Review Focus #2)', async () => {
    expect(
      (await whoami(agent.fingerprint, '10.0.0.5', { 'x-forwarded-for': '172.30.0.10' })).statusCode,
    ).toBe(401);
  });

  it('accepts an IPv4-mapped IPv6 Caddy address', async () => {
    expect((await whoami(agent.fingerprint, '::ffff:172.30.0.10')).statusCode).toBe(200);
  });

  it('rejects unknown fingerprints and missing headers', async () => {
    expect((await whoami('f'.repeat(64))).statusCode).toBe(401);
    const bare = await t.app.inject({ method: 'GET', url: '/agent/v1/whoami', remoteAddress: '172.30.0.10' });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().code).toBe('agent_unauthorized');
  });

  it('rejects a user session on agent routes and an agent fingerprint on user routes', async () => {
    const withCookie = await t.app.inject({
      method: 'GET',
      url: '/agent/v1/whoami',
      headers: headers(owner.cookie),
    });
    expect(withCookie.statusCode).toBe(401);
    const userRoute = await t.app.inject({ method: 'GET', url: '/api/v1/me', ...asAgent(agent.fingerprint) });
    expect(userRoute.statusCode).toBe(401);
  });
});

describe('credential lifecycle in the guard', () => {
  it('honours revocation within the 30 s cache window (TC-03-06)', async () => {
    const agent = await enrolledAgent(t, owner, environmentId);
    expect((await whoami(agent.fingerprint)).statusCode).toBe(200);
    await sql(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agent.agentId]);
    now += 29_000;
    expect((await whoami(agent.fingerprint)).statusCode).toBe(200);
    now += 2_000;
    expect((await whoami(agent.fingerprint)).statusCode).toBe(401);
  });

  it('rejects an expired certificate', async () => {
    const agent = await enrolledAgent(t, owner, environmentId);
    await sql(`UPDATE agent_credentials SET not_after = $2 WHERE agent_id = $1`, [
      agent.agentId,
      new Date(now - 1000),
    ]);
    expect((await whoami(agent.fingerprint)).statusCode).toBe(401);
  });

  it('accepts a superseded certificate for 1 h only', async () => {
    const agent = await enrolledAgent(t, owner, environmentId);
    await sql(`UPDATE agent_credentials SET superseded_at = $2 WHERE agent_id = $1`, [
      agent.agentId,
      new Date(now),
    ]);
    now += 59 * 60_000;
    expect((await whoami(agent.fingerprint)).statusCode).toBe(200);
    now += 2 * 60_000 + 31_000;
    expect((await whoami(agent.fingerprint)).statusCode).toBe(401);
  });
});
