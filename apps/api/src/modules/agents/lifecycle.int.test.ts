import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentCsr,
  agentEnv,
  asAgent,
  createEnrollment,
  enrollRequest,
  enrolledAgent,
  environmentFor,
} from '../../../test/agent-helpers.js';
import { createTestApp, uniqueIp, type TestApp } from '../../../test/app-factory.js';
import { headers, login, ownerWithOrg, signUpAndVerify, type Owner } from '../../../test/auth-helpers.js';
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

const fingerprintOf = (pem: string) =>
  createHash('sha256')
    .update(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64'))
    .digest('hex');

const whoami = (fp: string) => t.app.inject({ method: 'GET', url: '/agent/v1/whoami', ...asAgent(fp) });

describe('certificate rotation (UC-03-04, TC-03-08)', () => {
  it('issues a new certificate and keeps the old one for 1 h only', async () => {
    const agent = await enrolledAgent(t, owner, environmentId);
    const res = await t.app.inject({
      method: 'POST',
      url: '/agent/v1/rotate',
      ...asAgent(agent.fingerprint),
      payload: { csrPem: await agentCsr() },
    });
    expect(res.statusCode, res.body).toBe(201);
    const fresh = fingerprintOf(res.json().certificatePem);
    expect(fresh).not.toBe(agent.fingerprint);
    expect(res.json().notAfter).toBeDefined();
    expect((await whoami(fresh)).statusCode).toBe(200);
    now += 59 * 60_000;
    try {
      expect((await whoami(agent.fingerprint)).statusCode).toBe(200);
      now += 2 * 60_000 + 31_000;
      expect((await whoami(agent.fingerprint)).statusCode).toBe(401);
      expect((await whoami(fresh)).statusCode).toBe(200);
    } finally {
      now -= 61 * 60_000 + 31_000;
    }
    const [audit] = await sql(
      `SELECT 1 FROM audit_logs WHERE action = 'agent.certificate_rotated' AND target_id = $1`,
      [agent.agentId],
    );
    expect(audit).toBeDefined();
  });

  it('rejects a bad CSR', async () => {
    const agent = await enrolledAgent(t, owner, environmentId);
    const res = await t.app.inject({
      method: 'POST',
      url: '/agent/v1/rotate',
      ...asAgent(agent.fingerprint),
      payload: { csrPem: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('revocation (UC-03-06)', () => {
  it('locks the agent out immediately, expires its tasks, and audits', async () => {
    const agent = await enrolledAgent(t, owner, environmentId);
    expect((await whoami(agent.fingerprint)).statusCode).toBe(200);
    const task = await t.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.agentId}/diagnostics`,
      headers: headers(owner.cookie),
      payload: {},
    });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.agentId}/revoke`,
      headers: headers(owner.cookie),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'revoked' });
    await new Promise((r) => setTimeout(r, 200));
    expect((await whoami(agent.fingerprint)).statusCode).toBe(401);
    const [row] = await sql<{ status: string }>(`SELECT status FROM agent_tasks WHERE id = $1`, [
      task.json().taskId,
    ]);
    expect(row!.status).toBe('expired');
    const [audit] = await sql(`SELECT 1 FROM audit_logs WHERE action = 'agent.revoked' AND target_id = $1`, [
      agent.agentId,
    ]);
    expect(audit).toBeDefined();
    const detail = await t.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.agentId}`,
      headers: headers(owner.cookie),
    });
    expect(detail.json().status).toBe('revoked');
  });

  it('is not available to analysts (404)', async () => {
    const agent = await enrolledAgent(t, owner, environmentId);
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'analyst')`,
      [randomUUID(), owner.orgId, u!.id],
    );
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.agentId}/revoke`,
      headers: headers(await login(t, email)),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('revokes an enrollment token so it answers like an unknown one', async () => {
    const e = await createEnrollment(t, owner, environmentId, { maxUses: 5 });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/environments/${environmentId}/agent-enrollments/${e.id}/revoke`,
      headers: headers(owner.cookie),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    const enroll = await t.app.inject({
      method: 'POST',
      url: '/agent/v1/enroll',
      remoteAddress: uniqueIp(),
      payload: await enrollRequest(e.token),
    });
    expect(enroll.statusCode).toBe(401);
    expect(enroll.json().code).toBe('invalid_enrollment_token');
  });
});
