import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
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

const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({
    method,
    url,
    headers: payload ? headers(cookie) : { cookie },
    ...(payload ? { payload } : {}),
  });

async function agentWithPacks(owner: Owner, version = '0.5.0') {
  const { environmentId } = await environmentFor(t, owner);
  const agent = await enrolledAgent(t, owner, environmentId);
  await sql(`UPDATE agents SET agent_version = $2 WHERE id = $1`, [agent.agentId, version]);
  for (const pack of ['redis', 'kafka'])
    await sql(
      `INSERT INTO agent_pack_assignments (organization_id, agent_id, pack_id, settings, status, policy_version, updated_at)
       VALUES ($1, $2, $3, '{"endpoint":"127.0.0.1:1"}', 'applied', 2, now())`,
      [owner.orgId, agent.agentId, pack],
    );
  return agent;
}

async function memberWith(owner: Owner, role: string) {
  const email = await signUpAndVerify(t);
  const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  await sql(`INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
    randomUUID(),
    owner.orgId,
    u!.id,
    role,
  ]);
  return login(t, email);
}

/** The agent picks up the queued inspect task and answers it. */
async function answer(agent: EnrolledAgent, result: object) {
  const poll = await t.app.inject({
    method: 'GET',
    url: '/agent/v1/tasks?wait=0',
    ...asAgent(agent.fingerprint),
  });
  const task = poll.json().tasks.find((x: { type: string }) => x.type === 'inspect');
  expect(task).toBeTruthy();
  const res = await t.app.inject({
    method: 'POST',
    url: `/agent/v1/tasks/${task.id}/result`,
    ...asAgent(agent.fingerprint),
    headers: { ...asAgent(agent.fingerprint).headers, 'content-type': 'application/json' },
    payload: { status: 'succeeded', result },
  });
  expect(res.statusCode, res.body).toBe(204);
  return task;
}

describe('data inspection (M18.2, WB-12)', () => {
  it('BR-12-06: off by default; owners turn it on with exact key and topic names, audited', async () => {
    const owner = await ownerWithOrg(t);
    const agent = await agentWithPacks(owner);
    const off = await call(owner.cookie, 'POST', `/api/v1/agents/${agent.agentId}/inspections`, {
      packId: 'redis',
      target: 'redis',
    });
    expect(off.json().code).toBe('inspection_disabled');
    const bad = await call(owner.cookie, 'PATCH', `/api/v1/agents/${agent.agentId}/packs/redis/inspection`, {
      enabled: true,
      redisKeys: ['user:*'],
    });
    expect(bad.statusCode).toBe(400);
    const ok = await call(owner.cookie, 'PATCH', `/api/v1/agents/${agent.agentId}/packs/redis/inspection`, {
      enabled: true,
      redisKeys: ['jobs'],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ enabled: true, redisKeys: ['jobs'], peekTopics: [] });
    const operator = await memberWith(owner, 'operator');
    expect(
      (
        await call(operator, 'PATCH', `/api/v1/agents/${agent.agentId}/packs/redis/inspection`, {
          enabled: false,
        })
      ).statusCode,
    ).toBe(404);
    const [audit] = await sql<{ action: string }>(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action = 'inspection.configured'`,
      [owner.orgId],
    );
    expect(audit).toBeTruthy();
  });

  it('an operator runs a Redis inspection; the agent gets the allowlisted keys and the stats are kept', async () => {
    const owner = await ownerWithOrg(t);
    const agent = await agentWithPacks(owner);
    await call(owner.cookie, 'PATCH', `/api/v1/agents/${agent.agentId}/packs/redis/inspection`, {
      enabled: true,
      redisKeys: ['jobs'],
    });
    const operator = await memberWith(owner, 'operator');
    const req = await call(operator, 'POST', `/api/v1/agents/${agent.agentId}/inspections`, {
      packId: 'redis',
      target: 'redis',
    });
    expect(req.statusCode, req.body).toBe(202);
    const task = await answer(agent, {
      inspection: { dbSize: 42, keys: [{ key: 'jobs', type: 'list', length: 17 }] },
    });
    expect(task.payload).toMatchObject({ target: 'redis', packId: 'redis', keys: ['jobs'] });
    const view = await call(operator, 'GET', `/api/v1/inspections/${req.json().id}`);
    expect(view.json()).toMatchObject({ status: 'succeeded', target: 'redis', result: { dbSize: 42 } });
    // The task result row holds no inspection values (only the inspection request does).
    const [stored] = await sql<{ result: unknown }>(
      `SELECT result FROM agent_task_results WHERE task_id = $1`,
      [task.id],
    );
    expect(stored!.result).toBeNull();
  });

  it('TC-12-07: a Kafka peek needs an allowlisted topic and a reason, and its messages never reach PostgreSQL', async () => {
    const owner = await ownerWithOrg(t);
    const agent = await agentWithPacks(owner);
    await call(owner.cookie, 'PATCH', `/api/v1/agents/${agent.agentId}/packs/kafka/inspection`, {
      enabled: true,
      peekTopics: ['orders'],
    });
    const url = `/api/v1/agents/${agent.agentId}/inspections`;
    expect(
      (
        await call(owner.cookie, 'POST', url, {
          packId: 'kafka',
          target: 'kafka_peek',
          topic: 'audit',
          reason: 'debug',
        })
      ).json().code,
    ).toBe('topic_not_allowlisted');
    expect(
      (await call(owner.cookie, 'POST', url, { packId: 'kafka', target: 'kafka_peek', topic: 'orders' }))
        .statusCode,
    ).toBe(400);
    const req = await call(owner.cookie, 'POST', url, {
      packId: 'kafka',
      target: 'kafka_peek',
      topic: 'orders',
      reason: 'order 42 stuck',
    });
    expect(req.statusCode).toBe(202);
    const task = await answer(agent, {
      inspection: [{ partition: 0, offset: 7, value: '{"order":42,"email":"[redacted]"}' }],
    });
    expect(task.payload).toMatchObject({
      target: 'kafka_peek',
      topic: 'orders',
      allowedTopics: ['orders'],
      limit: 20,
    });
    const view = (await call(owner.cookie, 'GET', `/api/v1/inspections/${req.json().id}`)).json();
    expect(view.result).toEqual([{ partition: 0, offset: 7, value: '{"order":42,"email":"[redacted]"}' }]);
    const rows = await sql(
      `SELECT r.result AS a, t.result AS b FROM inspection_requests r LEFT JOIN agent_task_results t ON t.task_id = r.task_id WHERE r.id = $1`,
      [req.json().id],
    );
    expect(JSON.stringify(rows)).not.toContain('order":42');
    const [audit] = await sql<{ metadata: { reason: string; topic: string } }>(
      `SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'inspection.requested' AND metadata->>'target' = 'kafka_peek'`,
      [owner.orgId],
    );
    expect(audit!.metadata).toMatchObject({ reason: 'order 42 stuck', topic: 'orders' });
  });

  it('refuses viewers, agents older than 0.5.0, and packs that are not inspectable', async () => {
    const owner = await ownerWithOrg(t);
    const agent = await agentWithPacks(owner, '0.4.0');
    await call(owner.cookie, 'PATCH', `/api/v1/agents/${agent.agentId}/packs/redis/inspection`, {
      enabled: true,
    });
    const url = `/api/v1/agents/${agent.agentId}/inspections`;
    expect((await call(owner.cookie, 'POST', url, { packId: 'redis', target: 'redis' })).json().code).toBe(
      'agent_upgrade_required',
    );
    expect((await call(owner.cookie, 'POST', url, { packId: 'redis', target: 'kafka' })).statusCode).toBe(
      400,
    );
    const viewer = await memberWith(owner, 'viewer');
    expect((await call(viewer, 'POST', url, { packId: 'redis', target: 'redis' })).statusCode).toBe(404);
  });
});
