import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentEnv, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, login, ownerWithOrg, signUpAndVerify, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';
import type { InstallerRunner, RunnerCreate } from './runner.client.js';

const INTERNAL = 'internal-token-for-install-sessions-test';

/** Records what the API asks of the runner; the runner's own tests cover SSH. */
class FakeRunner implements InstallerRunner {
  created: RunnerCreate[] = [];
  connects: Array<{ id: string; password?: string }> = [];
  confirms: Array<{ id: string; hostId: string; fingerprint: string }> = [];
  aborted: string[] = [];
  async create(req: RunnerCreate) {
    this.created.push(req);
    return { publicKey: req.mode === 'key' ? `ssh-ed25519 AAAAtest pcp-install-${req.sessionId}` : '' };
  }
  async connect(id: string, password?: string) {
    this.connects.push({ id, password });
  }
  async confirm(id: string, hostId: string, fingerprint: string) {
    this.confirms.push({ id, hostId, fingerprint });
  }
  async abort(id: string) {
    this.aborted.push(id);
  }
}

let t: TestApp;
const runner = new FakeRunner();

beforeAll(async () => {
  t = await createTestApp({
    env: { ...(await agentEnv()), INTERNAL_TOKEN: INTERNAL, INSTALLER_EGRESS_IPS: '203.0.113.7' },
    installerRunner: runner,
  });
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  runner.created = [];
  runner.connects = [];
  runner.confirms = [];
  runner.aborted = [];
});

const call = (cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  // No JSON content type without a body: Fastify rejects an empty JSON body.
  t.app.inject({
    method,
    url,
    headers: payload ? headers(cookie) : { cookie },
    ...(payload ? { payload } : {}),
  });

const report = (sessionId: string, hostId: string, payload: object) =>
  t.app.inject({
    method: 'POST',
    url: `/internal/v1/install-sessions/${sessionId}/hosts/${hostId}`,
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL },
    payload,
  });

async function start(owner: Owner, payload: object) {
  const { environmentId } = await environmentFor(t, owner);
  const res = await call(
    owner.cookie,
    'POST',
    `/api/v1/environments/${environmentId}/install-sessions`,
    payload,
  );
  return res;
}

describe('assisted install sessions (M17.3, UC-05-05)', () => {
  it('creates a session with its own fleet token, then installs after the fingerprint is confirmed', async () => {
    const owner = await ownerWithOrg(t);
    const res = await start(owner, {
      mode: 'key',
      hosts: [{ host: '198.51.100.10' }, { host: 'web-2.example.com', port: 2222 }],
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({ mode: 'key', status: 'awaiting_key', egressIps: ['203.0.113.7'] });
    expect(s.publicKey).toMatch(/^ssh-ed25519 /);
    expect(s.setupCommand).toContain('useradd -m -s /bin/bash pcp-install');
    expect(s.setupCommand).toContain(s.publicKey);
    expect(
      s.hosts.map((h: { host: string; port: number; username: string }) => [h.host, h.port, h.username]),
    ).toEqual([
      ['198.51.100.10', 22, 'pcp-install'],
      ['web-2.example.com', 2222, 'pcp-install'],
    ]);
    // The runner gets the token and URLs; the browser never does.
    const [created] = runner.created;
    expect(created!.install.token).toMatch(/^pcp_enr_/);
    expect(res.body).not.toContain(created!.install.token);
    expect(created!.organizationId).toBe(owner.orgId);
    const [enrollment] = await sql<{ max_uses: number }>(
      `SELECT max_uses FROM agent_enrollments WHERE id = (SELECT enrollment_id FROM install_sessions WHERE id = $1)`,
      [s.id],
    );
    expect(enrollment!.max_uses).toBe(2);

    expect(
      (await call(owner.cookie, 'POST', `/api/v1/install-sessions/${s.id}/connect`, {})).statusCode,
    ).toBe(202);
    expect(runner.connects).toEqual([{ id: s.id }]);
    const [h1, h2] = s.hosts as Array<{ id: string }>;
    expect(
      (
        await report(s.id, h1!.id, {
          organizationId: owner.orgId,
          status: 'awaiting_confirmation',
          fingerprint: 'SHA256:abc',
        })
      ).statusCode,
    ).toBe(204);
    // TC-05-06: a different fingerprint is refused and nothing reaches the runner.
    const wrong = await call(
      owner.cookie,
      'POST',
      `/api/v1/install-sessions/${s.id}/hosts/${h1!.id}/confirm-fingerprint`,
      { fingerprint: 'SHA256:other' },
    );
    expect(wrong.statusCode).toBe(409);
    const notYet = await call(
      owner.cookie,
      'POST',
      `/api/v1/install-sessions/${s.id}/hosts/${h2!.id}/confirm-fingerprint`,
      { fingerprint: 'SHA256:abc' },
    );
    expect(notYet.statusCode).toBe(409);
    expect(runner.confirms).toEqual([]);
    const ok = await call(
      owner.cookie,
      'POST',
      `/api/v1/install-sessions/${s.id}/hosts/${h1!.id}/confirm-fingerprint`,
      { fingerprint: 'SHA256:abc' },
    );
    expect(ok.statusCode).toBe(202);
    expect(runner.confirms).toEqual([{ id: s.id, hostId: h1!.id, fingerprint: 'SHA256:abc' }]);

    await report(s.id, h1!.id, {
      organizationId: owner.orgId,
      status: 'installed',
      output: 'done [redacted]',
      scriptVersion: 'abc123',
      cleanup: 'done',
    });
    await report(s.id, h2!.id, {
      organizationId: owner.orgId,
      status: 'failed',
      error: 'cannot reach web-2.example.com:2222',
    });
    const view = (await call(owner.cookie, 'GET', `/api/v1/install-sessions/${s.id}`)).json();
    expect(view.status).toBe('failed');
    expect(view.hosts[0]).toMatchObject({
      status: 'installed',
      cleanup: 'done',
      scriptVersion: 'abc123',
      output: 'done [redacted]',
    });
    expect(view.hosts[0].fingerprintConfirmedAt).toBeTruthy();
    expect(view.hosts[1]).toMatchObject({ status: 'failed', error: 'cannot reach web-2.example.com:2222' });
    // A finished session's token cannot enroll anything more.
    const [revoked] = await sql<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM agent_enrollments WHERE id = (SELECT enrollment_id FROM install_sessions WHERE id = $1)`,
      [s.id],
    );
    expect(revoked!.revoked_at).not.toBeNull();
    const audit = await sql<{ action: string }>(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'install_session.%' ORDER BY created_at`,
      [owner.orgId],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'install_session.created',
      'install_session.connect',
      'install_session.fingerprint_confirmed',
      'install_session.host_finished',
      'install_session.host_finished',
    ]);
  });

  it('TC-05-09: password mode passes the password to the runner only', async () => {
    const owner = await ownerWithOrg(t);
    const s = (
      await start(owner, { mode: 'password', hosts: [{ host: '198.51.100.11', username: 'admin' }] })
    ).json();
    expect(s.publicKey).toBeNull();
    expect(s.setupCommand).toBeNull();
    expect(
      (await call(owner.cookie, 'POST', `/api/v1/install-sessions/${s.id}/connect`, {})).statusCode,
    ).toBe(400);
    const res = await call(owner.cookie, 'POST', `/api/v1/install-sessions/${s.id}/connect`, {
      password: 'Tr0ub4dor&3',
    });
    expect(res.statusCode).toBe(202);
    expect(runner.connects).toEqual([{ id: s.id, password: 'Tr0ub4dor&3' }]);
    const rows = await sql(
      `SELECT * FROM install_sessions s JOIN install_session_hosts h ON h.session_id = s.id WHERE s.id = $1`,
      [s.id],
    );
    expect(JSON.stringify(rows)).not.toContain('Tr0ub4dor');
    const audit = await sql(`SELECT metadata FROM audit_logs WHERE organization_id = $1`, [owner.orgId]);
    expect(JSON.stringify(audit)).not.toContain('Tr0ub4dor');
  });

  it('validates hosts, aborts with the runner, and hides sessions from viewers', async () => {
    const owner = await ownerWithOrg(t);
    expect((await start(owner, { mode: 'key', hosts: [] })).statusCode).toBe(400);
    expect(
      (
        await start(owner, {
          mode: 'key',
          hosts: Array.from({ length: 11 }, (_, i) => ({ host: `10.0.0.${i}` })),
        })
      ).statusCode,
    ).toBe(400);
    expect((await start(owner, { mode: 'key', hosts: [{ host: 'a b; rm -rf /' }] })).statusCode).toBe(400);
    expect((await start(owner, { mode: 'password', hosts: [{ host: '10.0.0.1' }] })).statusCode).toBe(400);
    const s = (await start(owner, { mode: 'key', hosts: [{ host: '10.0.0.1' }] })).json();
    expect((await call(owner.cookie, 'DELETE', `/api/v1/install-sessions/${s.id}`)).statusCode).toBe(204);
    expect(runner.aborted).toEqual([s.id]);
    const view = (await call(owner.cookie, 'GET', `/api/v1/install-sessions/${s.id}`)).json();
    expect(view.status).toBe('aborted');
    expect(view.hosts[0].status).toBe('aborted');
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`,
      [randomUUID(), owner.orgId, u!.id],
    );
    const viewer = await login(t, email);
    expect((await call(viewer, 'GET', `/api/v1/install-sessions/${s.id}`)).statusCode).toBe(404);
    expect(
      (await report(s.id, s.hosts[0].id, { organizationId: randomUUID(), status: 'installed' })).statusCode,
    ).toBe(404);
    const noToken = await t.app.inject({
      method: 'POST',
      url: `/internal/v1/install-sessions/${s.id}/hosts/${s.hosts[0].id}`,
      payload: { organizationId: owner.orgId, status: 'installed' },
    });
    expect(noToken.statusCode).toBe(401);
  });
});
