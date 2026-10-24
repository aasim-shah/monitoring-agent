import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnv, enrolledAgent, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, ownerWithOrg } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

const TOKEN = 'internal-test-token-0123456789abcdef';
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { ...(await agentEnv()), INTERNAL_TOKEN: TOKEN } });
});

afterAll(async () => {
  await t?.close();
});

const lookup = (fp: string, token?: string) =>
  t.app.inject({
    method: 'GET',
    url: `/internal/agents/by-fingerprint/${fp}`,
    headers: token ? { 'x-internal-token': token } : {},
  });

describe('internal agent lookup (for the ingest gateway)', () => {
  it('returns the tenant scope of a valid credential', async () => {
    const owner = await ownerWithOrg(t);
    const { productId, environmentId } = await environmentFor(t, owner);
    const agent = await enrolledAgent(t, owner, environmentId);
    const res = await lookup(agent.fingerprint, TOKEN);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      agentId: agent.agentId,
      organizationId: owner.orgId,
      productId,
      environmentId,
      // M18.1: the gateway stamps retained logs with the tenant's AccountID.
      logsAccountId: expect.any(Number),
    });
  });

  it('answers 404 for revoked, expired, and unknown credentials', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const revoked = await enrolledAgent(t, owner, environmentId);
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${revoked.agentId}/revoke`,
      headers: headers(owner.cookie),
      payload: {},
    });
    expect((await lookup(revoked.fingerprint, TOKEN)).statusCode).toBe(404);
    const expired = await enrolledAgent(t, owner, environmentId);
    await sql(`UPDATE agent_credentials SET not_after = now() - interval '1 minute' WHERE agent_id = $1`, [
      expired.agentId,
    ]);
    expect((await lookup(expired.fingerprint, TOKEN)).statusCode).toBe(404);
    expect((await lookup('a'.repeat(64), TOKEN)).statusCode).toBe(404);
  });

  it('requires the internal token', async () => {
    expect((await lookup('a'.repeat(64))).statusCode).toBe(401);
    expect((await lookup('a'.repeat(64), 'wrong')).statusCode).toBe(401);
  });
});

describe('internal routes without INTERNAL_TOKEN', () => {
  it('are not served', async () => {
    const plain = await createTestApp();
    try {
      const res = await plain.app.inject({
        method: 'GET',
        url: `/internal/agents/by-fingerprint/${'a'.repeat(64)}`,
        headers: { 'x-internal-token': '' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
