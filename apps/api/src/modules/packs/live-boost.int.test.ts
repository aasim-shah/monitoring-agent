import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnv, asAgent, enrolledAgent, environmentFor } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, ownerWithOrg, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: await agentEnv() });
});

afterAll(async () => {
  await t?.close();
});

async function agentWithRedis(owner: Owner, environmentId: string, version = '0.4.0') {
  const agent = await enrolledAgent(t, owner, environmentId);
  await sql(`UPDATE agents SET agent_version = $2 WHERE id = $1`, [agent.agentId, version]);
  await sql(
    `INSERT INTO agent_pack_assignments (organization_id, agent_id, pack_id, settings, status, policy_version, updated_at)
     VALUES ($1, $2, 'redis', '{"endpoint":"127.0.0.1:6379"}', 'applied', 2, now())`,
    [owner.orgId, agent.agentId],
  );
  return agent;
}

const boost = (owner: Owner, agentId: string, packId = 'redis') =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1/agents/${agentId}/live-boost`,
    headers: headers(owner.cookie),
    payload: { packId },
  });

describe('live boost (M10.7, BR-11-08)', () => {
  it('sends a signed 10-minute boost task for an enabled pack and lists it as active', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const agent = await agentWithRedis(owner, environmentId);
    const res = await boost(owner, agent.agentId);
    expect(res.statusCode, res.body).toBe(202);
    const expiresAt = Date.parse(res.json().expiresAt);
    expect(expiresAt - Date.now()).toBeGreaterThan(9.5 * 60_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    const poll = await t.app.inject({
      method: 'GET',
      url: '/agent/v1/tasks?wait=0',
      ...asAgent(agent.fingerprint),
    });
    const [task] = poll.json().tasks;
    expect(task).toMatchObject({ type: 'live_boost', payload: { packId: 'redis', intervalSeconds: 5 } });
    expect(task.payload.untilEpoch * 1000).toBe(expiresAt);
    // Asking again while active returns the same boost, without a second task.
    expect((await boost(owner, agent.agentId)).json().expiresAt).toBe(res.json().expiresAt);
    const { 'content-type': _ct, ...bare } = headers(owner.cookie);
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.agentId}/live-boost`,
      headers: bare,
    });
    expect(list.json().boosts).toEqual([{ packId: 'redis', expiresAt: res.json().expiresAt }]);
  });

  it('refuses a pack that is not enabled and an agent older than 0.4.0', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const agent = await agentWithRedis(owner, environmentId);
    expect((await boost(owner, agent.agentId, 'kafka')).json().code).toBe('pack_not_enabled');
    const old = await agentWithRedis(owner, environmentId, '0.3.0');
    expect((await boost(owner, old.agentId)).json().code).toBe('agent_upgrade_required');
  });

  it('allows at most 3 active boosts per organization; the 4th is refused (TC-11-05)', async () => {
    const owner = await ownerWithOrg(t);
    const { environmentId } = await environmentFor(t, owner);
    const agents = [];
    for (let i = 0; i < 4; i++) agents.push(await agentWithRedis(owner, environmentId));
    for (const a of agents.slice(0, 3)) expect((await boost(owner, a.agentId)).statusCode).toBe(202);
    const fourth = await boost(owner, agents[3]!.agentId);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe('boost_limit');
    // Expired boosts stop counting.
    await sql(
      `UPDATE agent_live_boosts SET expires_at = now() - interval '1 second' WHERE organization_id = $1`,
      [owner.orgId],
    );
    expect((await boost(owner, agents[3]!.agentId)).statusCode).toBe(202);
  });
});
