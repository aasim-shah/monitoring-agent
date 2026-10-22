import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentEnv,
  asAgent,
  enrolledAgent,
  environmentFor,
  type EnrolledAgent,
} from '../../../test/agent-helpers.js';
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

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const userReq = async (cookie: string, method: 'GET' | 'POST', url: string, payload?: Json) => {
  const { 'content-type': _, ...noBody } = headers(cookie);
  const res = await t.app.inject({
    method,
    url,
    headers: payload === undefined ? noBody : headers(cookie),
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, json: (res.body ? res.json() : {}) as Json };
};

const poll = async (w: EnrolledAgent) => {
  const res = await t.app.inject({ method: 'GET', url: '/agent/v1/tasks?wait=0', ...asAgent(w.fingerprint) });
  return (res.json() as { tasks: Json[] }).tasks;
};

const answer = (w: EnrolledAgent, taskId: string, body: Json) =>
  t.app.inject({
    method: 'POST',
    url: `/agent/v1/tasks/${taskId}/result`,
    ...asAgent(w.fingerprint),
    payload: body,
  });

async function setup() {
  const owner = await ownerWithOrg(t);
  const { productId, environmentId } = await environmentFor(t, owner);
  const worker = await enrolledAgent(
    t,
    owner,
    environmentId,
    { hostname: 'worker-1', machineId: randomUUID() },
    'private_worker',
  );
  return { owner, productId, environmentId, worker };
}

const pgConfig = (workerAgentId: string, extra: Json = {}) => ({
  workerAgentId,
  secretRef: 'firemaps-pg',
  host: '10.0.0.5',
  port: 5432,
  database: 'app',
  ...extra,
});

const createPrivate = (owner: Owner, config: Json, provider = 'postgres') =>
  userReq(owner.cookie, 'POST', `/api/v1/organizations/${owner.orgId}/connections`, {
    provider,
    displayName: 'App DB',
    executionLocation: 'private',
    config,
  });

describe('private connections (WB-07 UC-07-02)', () => {
  it('lists the database and custom REST connectors in the catalog', async () => {
    const { owner } = await setup();
    const res = await userReq(owner.cookie, 'GET', '/api/v1/connectors/catalog');
    expect(res.status).toBe(200);
    const types = (res.json.connectors as Json[]).map((c) => c.type);
    expect(types).toEqual(expect.arrayContaining(['postgres', 'mysql', 'mongodb', 'custom-http']));
  });

  it('requires a private worker of the same organization and a simple secretRef', async () => {
    const { owner, worker, environmentId } = await setup();
    const other = await setup();
    const host = await enrolledAgent(t, owner, environmentId, { hostname: 'web-1', machineId: randomUUID() });
    expect((await createPrivate(owner, pgConfig(other.worker.agentId))).status).toBe(400);
    expect((await createPrivate(owner, pgConfig(host.agentId))).status).toBe(400);
    expect(
      (await createPrivate(owner, pgConfig(worker.agentId, { secretRef: '../etc/passwd' }))).status,
    ).toBe(400);
    expect((await createPrivate(owner, { ...pgConfig(worker.agentId), password: 'nope' })).status).toBe(400);
  });

  it('validates through the worker: signed task out, status and health in (BR-07-01)', async () => {
    const { owner, worker } = await setup();
    const created = await createPrivate(owner, pgConfig(worker.agentId));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json.status).toBe('pending_validation');
    const id = created.json.id as string;
    expect(
      (
        await userReq(owner.cookie, 'POST', `/api/v1/connections/${id}/authorize`, {
          credentials: { password: 'x' },
        })
      ).status,
    ).toBe(400);

    const [task] = await poll(worker);
    expect(task).toMatchObject({
      type: 'connector_op',
      signature: expect.any(String),
      payload: {
        connectionId: id,
        provider: 'postgres',
        operation: 'validate',
        config: { secretRef: 'firemaps-pg', host: '10.0.0.5' },
      },
    });
    expect(
      (
        await answer(worker, task!.id, {
          status: 'succeeded',
          result: { operation: 'validate', ok: true, accountId: 'ro@10.0.0.5/app' },
        })
      ).statusCode,
    ).toBe(204);
    const after = await userReq(owner.cookie, 'GET', `/api/v1/connections/${id}`);
    expect(after.json).toMatchObject({ status: 'connected', statusReason: null });
    expect(after.json.lastValidatedAt).not.toBeNull();

    // A health check follows right away.
    const [health] = await poll(worker);
    expect(health!.payload).toMatchObject({ operation: 'health', connectionId: id });
    await answer(worker, health!.id, {
      status: 'succeeded',
      result: { operation: 'health', ok: true, data: { connections: 7, maxConnections: 100 } },
    });
    const h = await userReq(owner.cookie, 'GET', `/api/v1/connections/${id}/health`);
    expect(h.status).toBe(200);
    expect(h.json.latest).toMatchObject({ ok: true, data: { connections: 7, maxConnections: 100 } });

    // No credential anywhere in the control plane for this connection.
    const [secret] = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM connection_secrets WHERE connection_id = $1`,
      [id],
    );
    expect(secret!.n).toBe('0');
  });

  it('a write-capable user degrades the connection until an admin acknowledges (UC-07-06)', async () => {
    const { owner, worker } = await setup();
    const id = (await createPrivate(owner, pgConfig(worker.agentId))).json.id as string;
    const [task] = await poll(worker);
    await answer(worker, task!.id, {
      status: 'failed',
      error: 'the database user can write to 3 table(s)',
      result: { operation: 'validate', reason: 'permission_denied' },
    });
    expect((await userReq(owner.cookie, 'GET', `/api/v1/connections/${id}`)).json).toMatchObject({
      status: 'degraded',
      statusReason: 'permission_denied',
    });
    expect((await userReq(owner.cookie, 'POST', `/api/v1/connections/${id}/write-override`, {})).status).toBe(
      202,
    );
    const [again] = await poll(worker);
    expect(again!.payload).toMatchObject({
      operation: 'validate',
      config: { writeOverrideAcknowledged: true },
    });
    const [audit] = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM audit_logs WHERE target_id = $1 AND action = 'connection.write_override'`,
      [id],
    );
    expect(audit!.n).toBe('1');
  });

  it('shows worker_offline instead of a stale status (Review Focus #5)', async () => {
    const { owner, worker } = await setup();
    const id = (await createPrivate(owner, pgConfig(worker.agentId))).json.id as string;
    await sql(
      `UPDATE agents SET last_heartbeat_at = now() - interval '20 minutes', created_at = now() - interval '1 day' WHERE id = $1`,
      [worker.agentId],
    );
    expect((await userReq(owner.cookie, 'GET', `/api/v1/connections/${id}`)).json).toMatchObject({
      status: 'degraded',
      statusReason: 'worker_offline',
    });
  });

  it('creates due health checks when the worker polls, without duplicates', async () => {
    const { owner, worker } = await setup();
    const id = (await createPrivate(owner, pgConfig(worker.agentId))).json.id as string;
    const [v] = await poll(worker);
    await answer(worker, v!.id, { status: 'succeeded', result: { operation: 'validate', ok: true } });
    const [h1] = await poll(worker);
    await answer(worker, h1!.id, {
      status: 'succeeded',
      result: { operation: 'health', ok: true, data: {} },
    });
    expect(await poll(worker)).toEqual([]); // fresh health: nothing due
    await sql(
      `UPDATE connection_health SET checked_at = now() - interval '6 minutes' WHERE connection_id = $1`,
      [id],
    );
    const due = await poll(worker);
    expect(due.map((x) => x.payload.operation)).toEqual(['health']);
    expect(await poll(worker)).toEqual([]); // the pending one is not duplicated
  });

  it('runs named templates for configurers only', async () => {
    const { owner, worker, productId } = await setup();
    const id = (await createPrivate(owner, pgConfig(worker.agentId))).json.id as string;
    await poll(worker);
    const run = await userReq(
      owner.cookie,
      'POST',
      `/api/v1/connections/${id}/templates/table_row_estimates/run`,
      {
        from: new Date(Date.now() - 86400_000).toISOString(),
        to: new Date().toISOString(),
      },
    );
    expect(run.status).toBe(202);
    const [task] = await poll(worker);
    expect(task!.payload).toMatchObject({ operation: 'template', template: 'table_row_estimates' });
    await answer(worker, task!.id, {
      status: 'succeeded',
      result: {
        operation: 'template',
        template: 'table_row_estimates',
        rows: [{ table: 'users', estimate: 10 }],
        truncated: false,
      },
    });
    expect(
      (await userReq(owner.cookie, 'GET', `/api/v1/connections/${id}/health`)).json.lastTemplate,
    ).toMatchObject({
      template: 'table_row_estimates',
      rows: [{ table: 'users', estimate: 10 }],
      truncated: false,
    });
    expect(
      (
        await userReq(owner.cookie, 'POST', `/api/v1/connections/${id}/templates/drop_all/run`, {
          from: '',
          to: '',
        })
      ).status,
    ).toBe(400);
    await sql(
      `INSERT INTO connection_resource_scopes (id, organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, $3, 'db', 'database', 'app', $4)`,
      [randomUUID(), owner.orgId, id, productId],
    );
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids) VALUES ($1, $2, $3, 'viewer', true, '{}')`,
      [randomUUID(), owner.orgId, u!.id],
    );
    const viewer = await login(t, email);
    expect(
      (
        await userReq(viewer, 'POST', `/api/v1/connections/${id}/templates/table_row_estimates/run`, {
          from: '',
          to: '',
        })
      ).status,
    ).toBe(404);
    expect((await userReq(viewer, 'GET', `/api/v1/connections/${id}/health`)).status).toBe(200);
  });
});
