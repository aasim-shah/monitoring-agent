import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnv, createEnrollment, enrollRequest, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, uniqueIp, type TestApp } from '../../../test/app-factory.js';
import { headers, login, ownerWithOrg, signUpAndVerify } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv() });
});

afterAll(async () => {
  await t?.close();
});

const enroll = async (payload: unknown, ip = uniqueIp()) =>
  t.app.inject({ method: 'POST', url: '/agent/v1/enroll', payload: payload as object, remoteAddress: ip });

describe('agent enrollment (WB-03)', () => {
  it('shows the token once and stores only its hash (TC-03-01)', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const e = await createEnrollment(t, owner, environmentId);
    expect(e.token).toMatch(/^pcp_enr_[A-Za-z0-9_-]{43}$/);
    expect(e.maxUses).toBe(1);
    expect(new Date(e.expiresAt).getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(e.installCommand).toContain(`--token ${e.token}`);
    const [row] = await sql<{ token_hash: string }>(
      `SELECT token_hash FROM agent_enrollments WHERE id = $1`,
      [e.id],
    );
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.token_hash).not.toContain(e.token);
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/v1/environments/${environmentId}/agent-enrollments`,
      headers: headers(owner.cookie),
    });
    expect(list.json().enrollments).toHaveLength(1);
    expect(list.body).not.toContain(e.token);
    expect(list.body).not.toContain(row!.token_hash);
  });

  it('enrolls with server-side tenant scope and returns a certificate for the new agent', async () => {
    const owner = await ownerWithOrg(t);
    const { productId, environmentId } = await environmentFor(t, owner);
    const e = await createEnrollment(t, owner, environmentId);
    const res = await enroll(await enrollRequest(e.token));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      controlUrl: 'https://agent.example.test',
      ingestUrl: 'https://ingest.example.test',
      opampUrl: 'wss://agent.example.test/agent/v1/opamp',
    });
    expect(Buffer.from(body.taskSigningPublicKey, 'base64')).toHaveLength(32);
    expect(new x509.X509Certificate(body.certificatePem).subject).toBe(`CN=${body.agentId}`);
    const [agent] = await sql<{
      organization_id: string;
      product_id: string;
      environment_id: string;
      hostname: string;
    }>(`SELECT organization_id, product_id, environment_id, hostname FROM agents WHERE id = $1`, [
      body.agentId,
    ]);
    expect(agent).toEqual({
      organization_id: owner.orgId,
      product_id: productId,
      environment_id: environmentId,
      hostname: 'vps-1',
    });
    const [cred] = await sql(`SELECT 1 FROM agent_credentials WHERE agent_id = $1`, [body.agentId]);
    expect(cred).toBeDefined();
    const [audit] = await sql(`SELECT 1 FROM audit_logs WHERE action = 'agent.enrolled' AND target_id = $1`, [
      body.agentId,
    ]);
    expect(audit).toBeDefined();
  });

  it('answers identically for unknown, exhausted, expired, and revoked tokens (TC-03-02)', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const used = await createEnrollment(t, owner, environmentId);
    expect((await enroll(await enrollRequest(used.token))).statusCode).toBe(201);
    const expired = await createEnrollment(t, owner, environmentId);
    await sql(`UPDATE agent_enrollments SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      expired.id,
    ]);
    const revoked = await createEnrollment(t, owner, environmentId);
    await sql(`UPDATE agent_enrollments SET revoked_at = now() WHERE id = $1`, [revoked.id]);
    const bodies = [];
    for (const token of [`pcp_enr_${'A'.repeat(43)}`, used.token, expired.token, revoked.token]) {
      const res = await enroll(await enrollRequest(token));
      expect(res.statusCode).toBe(401);
      const { requestId: _r, ...rest } = res.json();
      bodies.push(rest);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ code: 'invalid_enrollment_token', message: expect.any(String) });
  });

  it('lets exactly one of two racing hosts use a single-use token (Review Focus #1)', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const e = await createEnrollment(t, owner, environmentId);
    const [a, b] = await Promise.all([
      enroll(await enrollRequest(e.token)),
      enroll(await enrollRequest(e.token)),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 401]);
  });

  it('rejects tenant identifiers and unsupported protocol versions (TC-03-03, BR-03-08)', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const e = await createEnrollment(t, owner, environmentId, { maxUses: 3 });
    const withOrg = await enroll({ ...(await enrollRequest(e.token)), organizationId: randomUUID() });
    expect(withOrg.statusCode).toBe(400);
    const v2 = await enroll({ ...(await enrollRequest(e.token)), protocolVersion: '2.0' });
    expect(v2.statusCode).toBe(426);
    expect(v2.json().code).toBe('upgrade_required');
    const badCsr = await enroll({ ...(await enrollRequest(e.token)), csrPem: 'nope' });
    expect(badCsr.statusCode).toBe(400);
    const [row] = await sql<{ uses: number }>(`SELECT uses FROM agent_enrollments WHERE id = $1`, [e.id]);
    expect(row!.uses).toBe(0);
  });

  it('limits enrollment attempts per IP', async () => {
    const ip = uniqueIp();
    const codes = [];
    for (let i = 0; i < 11; i++)
      codes.push((await enroll(await enrollRequest(`pcp_enr_${'B'.repeat(43)}`), ip)).statusCode);
    expect(codes.at(-1)).toBe(429);
  });

  it('bounds maxUses and expiry, and hides enrollment from viewers (404)', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const url = `/api/v1/environments/${environmentId}/agent-enrollments`;
    const post = (cookie: string, payload: object) =>
      t.app.inject({ method: 'POST', url, headers: headers(cookie), payload });
    expect((await post(owner.cookie, { maxUses: 1001 })).statusCode).toBe(400);
    expect((await post(owner.cookie, { expiresInMinutes: 1441 })).statusCode).toBe(400);
    const fleet = await post(owner.cookie, { maxUses: 50, expiresInMinutes: 1440 });
    expect(fleet.json().maxUses).toBe(50);
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`,
      [randomUUID(), owner.orgId, u!.id],
    );
    expect((await post(await login(t, email), {})).statusCode).toBe(404);
  });
});

describe('agent enrollment without a configured CA', () => {
  it('answers 503 agent_enrollment_unavailable', async () => {
    const plain = await createTestApp();
    try {
      const owner = await ownerWithOrg(plain);
      const { environmentId } = await environmentFor(plain, owner);
      const res = await plain.app.inject({
        method: 'POST',
        url: `/api/v1/environments/${environmentId}/agent-enrollments`,
        headers: headers(owner.cookie),
        payload: {},
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('agent_enrollment_unavailable');
      const direct = await plain.app.inject({
        method: 'POST',
        url: '/agent/v1/enroll',
        payload: await enrollRequest('x'.repeat(30)),
      });
      expect(direct.statusCode).toBe(503);
    } finally {
      await plain.close();
    }
  });
});
