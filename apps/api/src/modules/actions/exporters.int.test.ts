import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnv, asAgent, enrolledAgent, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { enrollMfa, headers, login, ownerWithOrg, signUpAndVerify } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv() });
});

afterAll(async () => {
  await t?.close();
});

type Body = Record<string, unknown>;
const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Body) =>
  t.app.inject({
    method,
    url,
    headers: payload ? headers(cookie) : { cookie },
    ...(payload ? { payload } : {}),
  });

describe('Level 1 managed exporters (M18.3, spec §8.9)', () => {
  it('an approved install runs pack_install through the helper, then the agent scrapes the exporter', async () => {
    const owner = await ownerWithOrg(t);
    const { productId, environmentId } = await environmentFor(t, owner);
    const agent = await enrolledAgent(t, owner, environmentId, { hostname: 'vps-l1' });
    await sql(`UPDATE agents SET agent_version = '0.5.0' WHERE id = $1`, [agent.agentId]);
    const policy = await call(
      owner.cookie,
      'PUT',
      `/api/v1/products/${productId}/action-policies/host.install_exporter`,
      {
        environmentId,
        enabled: true,
        approverRoles: ['owner', 'admin'],
        requireApproval: true,
        settings: { exporters: ['redis_exporter'] },
      },
    );
    expect(policy.statusCode, policy.body).toBe(200);
    const proposal = (over: Body = {}) =>
      call(owner.cookie, 'POST', '/api/v1/actions/proposals', {
        productId,
        environmentId,
        capability: 'host.install_exporter',
        target: { agentId: agent.agentId },
        params: { exporter: 'redis_exporter' },
        idempotencyKey: randomUUID(),
        reason: 'deeper Redis metrics',
        ...over,
      });
    // The exporter reads the Redis pack's service: without the pack there is nothing to read.
    expect((await proposal()).json().code).toBe('pack_not_enabled');
    await sql(
      `INSERT INTO agent_pack_assignments (organization_id, agent_id, pack_id, settings, status, policy_version, updated_at)
       VALUES ($1, $2, 'redis', '{"endpoint":"127.0.0.1:6380"}', 'applied', 1, now())`,
      [owner.orgId, agent.agentId],
    );
    const res = await proposal();
    expect(res.json()).toMatchObject({ status: 'pending_approval' });
    // In production someone other than the requester approves (BR-16-03).
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role, all_products) VALUES ($1, $2, $3, 'admin', true)`,
      [randomUUID(), owner.orgId, u!.id],
    );
    const admin = await login(t, email);
    await enrollMfa(t, admin);
    const approved = await call(admin, 'POST', `/api/v1/actions/${res.json().id}/approve`, { note: 'ok' });
    expect(approved.statusCode, approved.body).toBe(200);
    const poll = await t.app.inject({
      method: 'GET',
      url: '/agent/v1/tasks?wait=0',
      ...asAgent(agent.fingerprint),
    });
    const task = poll.json().tasks.find((x: Body) => x.type === 'action');
    expect(task.payload).toEqual({
      capability: 'pack_install',
      exporter: 'redis_exporter',
      downloadUrl: 'http://localhost:8080/downloads',
      target: '127.0.0.1:6380',
    });
    const done = await t.app.inject({
      method: 'POST',
      url: `/agent/v1/tasks/${task.id}/result`,
      ...asAgent(agent.fingerprint),
      payload: { status: 'succeeded', result: { exporter: 'redis_exporter', listen: '127.0.0.1:9121' } },
    });
    expect(done.statusCode, done.body).toBe(204);
    const cfg = await t.app.inject({ method: 'GET', url: '/agent/v1/config', ...asAgent(agent.fingerprint) });
    expect(cfg.json().packs).toContainEqual(
      expect.objectContaining({ packId: 'redis-exporter', settings: { endpoint: '127.0.0.1:9121' } }),
    );
  });
});
