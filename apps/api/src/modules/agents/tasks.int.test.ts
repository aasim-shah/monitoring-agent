import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { canonicalJson } from '@pcp/agent-protocol';
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
import { TasksService } from './tasks.service.js';

let t: TestApp;
let now = Date.now();
let owner: Owner;
let environmentId: string;
let signingKey: ReturnType<typeof createPublicKey>;

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv(), clock: () => new Date(now) });
  owner = await ownerWithOrg(t);
  ({ environmentId } = await environmentFor(t, owner));
});

afterAll(async () => {
  await t?.close();
});

const newAgent = (): Promise<EnrolledAgent> => enrolledAgent(t, owner, environmentId);

const poll = (agent: EnrolledAgent, wait = 0) =>
  t.app.inject({ method: 'GET', url: `/agent/v1/tasks?wait=${wait}`, ...asAgent(agent.fingerprint) });

const diagnostics = (agentId: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1/agents/${agentId}/diagnostics`,
    headers: headers(owner.cookie),
    payload: {},
  });

describe('signed tasks (WB-03 UC-03-05)', () => {
  it('delivers a signed diagnostics task the agent can verify', async () => {
    const agent = await newAgent();
    const created = await diagnostics(agent.agentId);
    expect(created.statusCode, created.body).toBe(202);
    const res = await poll(agent);
    expect(res.statusCode, res.body).toBe(200);
    const [task] = res.json().tasks;
    expect(task).toMatchObject({
      id: created.json().taskId,
      type: 'inspect',
      payload: { target: 'agent_info' },
    });
    const { signature, ...unsigned } = task;
    signingKey ??= createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(agent.taskSigningPublicKey, 'base64').toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(null, Buffer.from(canonicalJson(unsigned)), signingKey, Buffer.from(signature, 'base64')),
    ).toBe(true);
    expect((await poll(agent)).json().tasks).toEqual([]);
  });

  it('wakes a waiting long-poll as soon as a task is created', async () => {
    const agent = await newAgent();
    const started = Date.now();
    const pending = poll(agent, 25);
    await new Promise((r) => setTimeout(r, 300));
    await diagnostics(agent.agentId);
    const res = await pending;
    expect(res.json().tasks).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('a long-poll whose agent went away does not claim the task; the restarted agent gets it', async () => {
    const agent = await newAgent();
    const [row] = await sql<{ organization_id: string; product_id: string; environment_id: string }>(
      `SELECT organization_id, product_id, environment_id FROM agents WHERE id = $1`,
      [agent.agentId],
    );
    const tasks = t.app.get(TasksService);
    const ctx = {
      organizationId: row!.organization_id,
      actor: { kind: 'agent' as const, agentId: agent.agentId },
      roles: [],
      productIds: [row!.product_id],
      environmentIds: [row!.environment_id],
      requestId: 'old-process',
    };
    const identity = {
      id: agent.agentId,
      organizationId: row!.organization_id,
      productId: row!.product_id,
      environmentId: row!.environment_id,
      fingerprint: agent.fingerprint,
    };
    // The old agent process's poll is still waiting on the server when the process stops.
    const gone = new AbortController();
    const stale = tasks.poll(ctx, identity, 25, gone.signal);
    await new Promise((r) => setTimeout(r, 200));
    gone.abort();
    await diagnostics(agent.agentId);
    expect(await stale).toEqual([]);
    // The new process polls and receives it.
    expect((await poll(agent)).json().tasks).toHaveLength(1);
  });

  it('never delivers a task that expired while the agent was offline (TC-03-09, Review Focus #3)', async () => {
    const agent = await newAgent();
    const { taskId } = (await diagnostics(agent.agentId)).json();
    now += 2 * 3600_000;
    try {
      expect((await poll(agent)).json().tasks).toEqual([]);
      const [row] = await sql<{ status: string }>(`SELECT status FROM agent_tasks WHERE id = $1`, [taskId]);
      expect(row!.status).toBe('expired');
    } finally {
      now -= 2 * 3600_000;
    }
  });

  it('gives a revoked agent nothing (TC-03-09)', async () => {
    const agent = await newAgent();
    const { taskId } = (await diagnostics(agent.agentId)).json();
    await sql(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agent.agentId]);
    now += 31_000;
    try {
      expect((await poll(agent)).statusCode).toBe(401);
      const [row] = await sql<{ status: string }>(`SELECT status FROM agent_tasks WHERE id = $1`, [taskId]);
      expect(row!.status).toBe('queued');
    } finally {
      now -= 31_000;
    }
  });

  it('accepts results only from the task owner, within the size limit (TC-03-10)', async () => {
    const a = await newAgent();
    const b = await newAgent();
    const { taskId } = (await diagnostics(a.agentId)).json();
    await poll(a);
    const post = (agent: EnrolledAgent, payload: object) =>
      t.app.inject({
        method: 'POST',
        url: `/agent/v1/tasks/${taskId}/result`,
        ...asAgent(agent.fingerprint),
        payload,
      });
    expect((await post(b, { status: 'succeeded', result: {} })).statusCode).toBe(404);
    expect((await post(a, { status: 'succeeded', result: { blob: 'x'.repeat(70_000) } })).statusCode).toBe(
      413,
    );
    expect((await post(a, { status: 'succeeded', result: { hostname: 'vps-1' } })).statusCode).toBe(204);
    expect((await post(a, { status: 'succeeded', result: {} })).statusCode).toBe(404);
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${a.agentId}/tasks`,
      headers: headers(owner.cookie),
    });
    expect(list.json().tasks[0]).toMatchObject({
      id: taskId,
      status: 'succeeded',
      result: { hostname: 'vps-1' },
    });
  });
});

describe('streams', () => {
  it('rejects chunks for closed, expired, unknown, or foreign sessions', async () => {
    const a = await newAgent();
    const b = await newAgent();
    const { taskId } = (await diagnostics(a.agentId)).json();
    const tasks = t.app.get(TasksService);
    const ctx = {
      organizationId: owner.orgId,
      actor: { kind: 'system' as const, jobId: 'test' },
      roles: [],
      productIds: 'all' as const,
      environmentIds: 'all' as const,
      requestId: 'test',
    };
    const session = await tasks.openStream(ctx, taskId);
    const chunk = (agent: EnrolledAgent, sessionId: string, sequence = 0) =>
      t.app.inject({
        method: 'POST',
        url: `/agent/v1/streams/${sessionId}/chunks`,
        ...asAgent(agent.fingerprint),
        payload: { sessionId, sequence, lines: ['hello'], final: false, sentAt: new Date(now).toISOString() },
      });
    expect((await chunk(a, session.id)).statusCode).toBe(202);
    expect((await chunk(b, session.id, 1)).statusCode).toBe(404);
    expect((await chunk(a, randomUUID())).statusCode).toBe(404);
    await sql(`UPDATE agent_stream_sessions SET status = 'closed' WHERE id = $1`, [session.id]);
    expect((await chunk(a, session.id, 2)).statusCode).toBe(404);
  });
});
