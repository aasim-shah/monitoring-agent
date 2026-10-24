import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnv, asAgent, enrolledAgent, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import {
  enrollMfa,
  headers,
  login,
  ownerWithOrg,
  signUpAndVerify,
  type Owner,
} from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;
// Real time at the start: enrollment tokens are checked against the database clock.
const START = new Date();
let now = START;

beforeAll(async () => {
  t = await createTestApp({ env: { ...(await agentEnv()), PCP_AI_FAKE: '1' }, clock: () => new Date(now) });
});

afterAll(async () => {
  await t?.close();
});

type Body = Record<string, unknown>;
const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Body) => {
  const { 'content-type': _, ...bare } = headers(cookie);
  return payload === undefined
    ? t.app.inject({ method, url, headers: bare })
    : t.app.inject({ method, url, headers: headers(cookie), payload });
};

async function member(owner: Owner, role: string) {
  const email = await signUpAndVerify(t);
  const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  await sql(
    `INSERT INTO organization_members (id, organization_id, user_id, role, all_products) VALUES ($1, $2, $3, $4, true)`,
    [randomUUID(), owner.orgId, u!.id, role],
  );
  const cookie = await login(t, email);
  // Admins and operators work with a second factor, as owners do.
  if (role !== 'viewer') await enrollMfa(t, cookie);
  return { cookie, userId: u!.id };
}

async function setup() {
  const owner = await ownerWithOrg(t);
  const { productId, environmentId } = await environmentFor(t, owner);
  const agent = await enrolledAgent(t, owner, environmentId, { hostname: 'vps-1' });
  await sql(`UPDATE agents SET agent_version = '0.3.0' WHERE id = $1`, [agent.agentId]);
  const admin = await member(owner, 'admin');
  const operator = await member(owner, 'operator');
  return { owner, productId, environmentId, agent, admin, operator };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const enable = (s: Setup, over: Body = {}) =>
  call(s.owner.cookie, 'PUT', `/api/v1/products/${s.productId}/action-policies/host.restart_service`, {
    environmentId: s.environmentId,
    enabled: true,
    approverRoles: ['owner', 'admin'],
    requireApproval: true,
    settings: { units: ['firemaps-api.service'] },
    ...over,
  });

const propose = (s: Setup, cookie: string, over: Body = {}) =>
  call(cookie, 'POST', '/api/v1/actions/proposals', {
    productId: s.productId,
    environmentId: s.environmentId,
    capability: 'host.restart_service',
    target: { agentId: s.agent.agentId },
    params: { unit: 'firemaps-api.service' },
    idempotencyKey: randomUUID(),
    reason: 'API stuck after deploy',
    ...over,
  });

const pollTasks = (s: Setup) =>
  t.app.inject({ method: 'GET', url: '/agent/v1/tasks?wait=0', ...asAgent(s.agent.fingerprint) });

const postResult = (s: Setup, taskId: string, payload: Body) =>
  t.app.inject({
    method: 'POST',
    url: `/agent/v1/tasks/${taskId}/result`,
    ...asAgent(s.agent.fingerprint),
    payload,
  });

const auditActions = async (orgId: string) =>
  (
    await sql<{ action: string; metadata: Body }>(
      `SELECT action, metadata FROM audit_logs WHERE organization_id = $1 AND action LIKE 'action%' ORDER BY created_at`,
      [orgId],
    )
  ).map((a) => a.action);

describe('action policies and proposals (WB-16 UC-16-01/02/04)', () => {
  it('TC-16-01: without an enabled policy a proposal is rejected and audited', async () => {
    const s = await setup();
    const res = await propose(s, s.operator.cookie);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'rejected_policy',
      reason: 'No enabled policy for host.restart_service in production',
    });
    expect(await auditActions(s.owner.orgId)).toEqual(['action.propose']);
  });

  it('policies start disabled; enabling one makes a proposal wait for approval with its impact', async () => {
    const s = await setup();
    const listed = (
      await call(s.owner.cookie, 'GET', `/api/v1/products/${s.productId}/action-policies`)
    ).json();
    expect(listed.policies.find((p: Body) => p.capability === 'host.restart_service')).toMatchObject({
      enabled: false,
      environmentId: s.environmentId,
    });
    expect((await enable(s)).statusCode).toBe(200);
    const res = await propose(s, s.operator.cookie);
    expect(res.json()).toMatchObject({
      status: 'pending_approval',
      proposedByAi: false,
      impact: {
        summary: 'Restarting firemaps-api.service on vps-1 has no known dependents in the asset graph.',
      },
    });
  });

  it('refuses units outside the policy allowlist and an agent too old for actions', async () => {
    const s = await setup();
    await enable(s);
    expect((await propose(s, s.operator.cookie, { params: { unit: 'sshd.service' } })).json()).toMatchObject({
      status: 'rejected_policy',
      reason: 'sshd.service is not in the policy allowlist',
    });
    await sql(`UPDATE agents SET agent_version = '0.2.0' WHERE id = $1`, [s.agent.agentId]);
    const old = await propose(s, s.operator.cookie);
    expect(old.statusCode).toBe(409);
    expect(old.json().code).toBe('agent_upgrade_required');
  });

  it('returns the original request for a repeated idempotency key (BR-16-06)', async () => {
    const s = await setup();
    await enable(s);
    const key = randomUUID();
    const a = (await propose(s, s.operator.cookie, { idempotencyKey: key })).json();
    const b = (await propose(s, s.operator.cookie, { idempotencyKey: key })).json();
    expect(b.id).toBe(a.id);
  });

  it('only members with action.propose can propose; other tenants get 404', async () => {
    const s = await setup();
    const other = await setup();
    await enable(s);
    const viewer = await member(s.owner, 'viewer');
    expect((await propose(s, viewer.cookie)).statusCode).toBe(404);
    expect((await propose(s, other.owner.cookie)).statusCode).toBe(404);
    const mine = (await propose(s, s.operator.cookie)).json();
    expect((await call(other.owner.cookie, 'GET', `/api/v1/actions/${mine.id}`)).statusCode).toBe(404);
  });
});

describe('approval, execution, and verification (UC-16-05/08/09)', () => {
  it('TC-16-02: refuses self-approval in production; another admin approves and a signed task goes out', async () => {
    const s = await setup();
    await enable(s);
    const req = (await propose(s, s.admin.cookie)).json();
    const self = await call(s.admin.cookie, 'POST', `/api/v1/actions/${req.id}/approve`, {});
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('self_approval');
    const ok = await call(s.owner.cookie, 'POST', `/api/v1/actions/${req.id}/approve`, { note: 'go' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'executing' });
    const [task] = (await pollTasks(s)).json().tasks;
    expect(task).toMatchObject({
      type: 'action',
      payload: { capability: 'service_restart', unit: 'firemaps-api.service' },
      resourceScope: { agentId: s.agent.agentId, unit: 'firemaps-api.service' },
      approvalId: expect.any(String),
      signature: expect.any(String),
    });
    expect(new Date(task.expiresAt).getTime() - now.getTime()).toBe(600_000);
  });

  it('records a verified restart as succeeded, with every audit field (TC-16-10)', async () => {
    const s = await setup();
    await enable(s);
    const req = (await propose(s, s.operator.cookie)).json();
    await call(s.admin.cookie, 'POST', `/api/v1/actions/${req.id}/approve`, {});
    const [task] = (await pollTasks(s)).json().tasks;
    const res = await postResult(s, task.id, {
      status: 'succeeded',
      result: { unit: 'firemaps-api.service', restarted: true, activeState: 'active' },
    });
    expect(res.statusCode, res.body).toBe(204);
    const done = (await call(s.operator.cookie, 'GET', `/api/v1/actions/${req.id}`)).json();
    expect(done).toMatchObject({ status: 'succeeded' });
    expect(done.executions[0]).toMatchObject({
      status: 'succeeded',
      location: 'agent',
      adapter: 'host.restart_service',
      verification: { activeState: 'active', verified: true },
    });
    const [audit] = await sql<{ metadata: Body }>(
      `SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'action.execute'`,
      [s.owner.orgId],
    );
    expect(Object.keys(audit!.metadata).sort()).toEqual(
      [
        'adapter',
        'adapterVersion',
        'approvers',
        'capability',
        'executionLocation',
        'finishedAt',
        'initiator',
        'policyDecision',
        'proposedByAi',
        'result',
        'startedAt',
        'target',
        'verification',
      ].sort(),
    );
  });

  it('TC-16-09: a unit that is not active after the restart fails with the reason', async () => {
    const s = await setup();
    await enable(s);
    const req = (await propose(s, s.operator.cookie)).json();
    await call(s.admin.cookie, 'POST', `/api/v1/actions/${req.id}/approve`, {});
    const [task] = (await pollTasks(s)).json().tasks;
    await postResult(s, task.id, {
      status: 'failed',
      result: { unit: 'firemaps-api.service', restarted: true, activeState: 'failed' },
      error: 'firemaps-api.service is failed after restart',
    });
    expect((await call(s.operator.cookie, 'GET', `/api/v1/actions/${req.id}`)).json()).toMatchObject({
      status: 'failed',
      reason: 'firemaps-api.service is failed after restart',
    });
  });

  it('TC-16-04: two approved restarts of one unit run one after the other', async () => {
    const s = await setup();
    await enable(s);
    const a = (await propose(s, s.operator.cookie)).json();
    const b = (await propose(s, s.operator.cookie)).json();
    await call(s.admin.cookie, 'POST', `/api/v1/actions/${a.id}/approve`, {});
    const second = await call(s.admin.cookie, 'POST', `/api/v1/actions/${b.id}/approve`, {});
    expect(second.json()).toMatchObject({ status: 'approved' }); // waiting for the target
    const first = (await pollTasks(s)).json().tasks;
    expect(first).toHaveLength(1);
    await postResult(s, first[0].id, { status: 'succeeded', result: { activeState: 'active' } });
    const next = (await pollTasks(s)).json().tasks;
    expect(next).toHaveLength(1);
    expect((await call(s.operator.cookie, 'GET', `/api/v1/actions/${b.id}`)).json().status).toBe('executing');
  });

  it('rejects with a note, and expires an undecided request after 1 h', async () => {
    const s = await setup();
    await enable(s);
    const a = (await propose(s, s.operator.cookie)).json();
    expect((await call(s.admin.cookie, 'POST', `/api/v1/actions/${a.id}/reject`, {})).statusCode).toBe(400);
    const rejected = await call(s.admin.cookie, 'POST', `/api/v1/actions/${a.id}/reject`, {
      note: 'Not during peak',
    });
    expect(rejected.json()).toMatchObject({ status: 'rejected' });
    const b = (await propose(s, s.operator.cookie)).json();
    now = new Date(now.getTime() + 61 * 60_000);
    try {
      expect((await call(s.operator.cookie, 'GET', `/api/v1/actions/${b.id}`)).json().status).toBe('expired');
      expect((await call(s.admin.cookie, 'POST', `/api/v1/actions/${b.id}/approve`, {})).statusCode).toBe(
        409,
      );
    } finally {
      now = START;
    }
    expect(await auditActions(s.owner.orgId)).toEqual(
      expect.arrayContaining(['action.propose', 'action.reject', 'action.expire']),
    );
  });

  it("lists a product's actions with their state", async () => {
    const s = await setup();
    await enable(s);
    await propose(s, s.operator.cookie);
    const list = (await call(s.operator.cookie, 'GET', `/api/v1/products/${s.productId}/actions`)).json();
    expect(list.actions).toEqual([
      expect.objectContaining({
        capability: 'host.restart_service',
        status: 'pending_approval',
        target: { agentId: s.agent.agentId },
      }),
    ]);
  });
});

describe('AI proposals (BR-16-02, TC-16-03)', () => {
  it('stay pending even under a no-approval policy outside production', async () => {
    const s = await setup();
    const res = await call(s.owner.cookie, 'POST', `/api/v1/products/${s.productId}/environments`, {
      name: 'qa',
    });
    expect(res.statusCode, res.body).toBe(201);
    const qa = res.json().id as string;
    const qaAgent = await enrolledAgent(t, s.owner, qa, { hostname: 'qa-1' });
    await sql(`UPDATE agents SET agent_version = '0.3.0' WHERE id = $1`, [qaAgent.agentId]);
    await call(
      s.owner.cookie,
      'PUT',
      `/api/v1/products/${s.productId}/action-policies/host.restart_service`,
      {
        environmentId: qa,
        enabled: true,
        approverRoles: [],
        requireApproval: false,
        settings: { units: ['firemaps-api.service'] },
      },
    );
    const human = (
      await propose(s, s.operator.cookie, { environmentId: qa, target: { agentId: qaAgent.agentId } })
    ).json();
    expect(human.status).toBe('executing');
    // The AI proposes through its tool in a conversation; it never approves or executes.
    const conv = (
      await call(s.operator.cookie, 'POST', `/api/v1/products/${s.productId}/ai/conversations`, {
        title: 'stuck',
      })
    ).json();
    const asked = await call(s.operator.cookie, 'POST', `/api/v1/ai/conversations/${conv.id}/messages`, {
      content: `Please restart firemaps-api.service on agent ${qaAgent.agentId}`,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const actions = (await call(s.operator.cookie, 'GET', `/api/v1/products/${s.productId}/actions`)).json()
      .actions;
    expect(actions.find((a: Body) => a.proposedByAi)).toMatchObject({
      status: 'pending_approval',
      proposedByAi: true,
    });
    const tasks = (
      await t.app.inject({ method: 'GET', url: '/agent/v1/tasks?wait=0', ...asAgent(qaAgent.fingerprint) })
    ).json().tasks;
    expect(tasks.filter((x: Body) => x.type === 'action')).toHaveLength(1); // the human's only
  });
});
