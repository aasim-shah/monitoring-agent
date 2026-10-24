import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { agentEnv, enrolledAgent, environmentFor, type EnrolledAgent } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, ownerWithOrg, type Owner } from '../../../test/auth-helpers.js';

let t: TestApp;
let owner: Owner;
let agent: EnrolledAgent;

beforeAll(async () => {
  t = await createTestApp({ env: { ...(await agentEnv()), VM_QUERY_URL: inject('vmUrl') } });
  owner = await ownerWithOrg(t);
  const { productId, environmentId } = await environmentFor(t, owner);
  agent = await enrolledAgent(t, owner, environmentId);
  const labels = `tenant_id="${owner.orgId}",product_id="${productId}",environment_id="${environmentId}",agent_id="${agent.agentId}"`;
  const vm = inject('vmUrl');
  const ts = Date.now() - 60_000;
  await fetch(`${vm}/api/v1/import/prometheus`, {
    method: 'POST',
    body: `http_server_request_duration_seconds_count{${labels},http_route="/maps/:id"} 42 ${ts}\n`,
  });
  await fetch(`${vm}/internal/force_flush`);
  for (const [packId, settings] of [
    ['nodejs', {}],
    ['nginx', { endpoint: 'http://127.0.0.1/nginx_status' }],
    ['redis', { endpoint: '127.0.0.1:6379' }],
  ] as const)
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.agentId}/packs`,
      headers: headers(owner.cookie),
      payload: { packId, settings },
    });
});

afterAll(async () => {
  await t?.close();
});

const get = (url: string) => {
  const { 'content-type': _ct, ...bare } = headers(owner.cookie);
  return t.app.inject({ method: 'GET', url, headers: bare });
};

describe('Level 2 guided setup (M10.5, WB-11 UC-11-04, BR-11-04)', () => {
  it('ships exact commands for Node.js, Kafka JVM, and nginx; the platform runs none of them', async () => {
    const packs = (await get('/api/v1/monitoring-packs')).json().packs as Array<{
      id: string;
      guide?: { steps: Array<{ text: string; command?: string }>; proof: string };
    }>;
    const guide = (id: string) => packs.find((p) => p.id === id)?.guide;
    expect(
      guide('nodejs')!
        .steps.map((s) => s.command ?? '')
        .join('\n'),
    ).toMatch(/NODE_OPTIONS/);
    expect(
      guide('nodejs')!
        .steps.map((s) => s.command ?? '')
        .join('\n'),
    ).toMatch(/127\.0\.0\.1:4318/);
    expect(
      guide('kafka')!
        .steps.map((s) => s.command ?? '')
        .join('\n'),
    ).toMatch(/javaagent.*127\.0\.0\.1:7071/);
    expect(
      guide('nginx')!
        .steps.map((s) => s.command ?? '')
        .join('\n'),
    ).toMatch(/stub_status/);
    expect(guide('redis')).toBeUndefined();
  });

  it('turns active when the proof metric arrives for this agent, and says not found otherwise (TC-11-06)', async () => {
    const node = await get(`/api/v1/agents/${agent.agentId}/packs/nodejs/verification`);
    expect(node.statusCode, node.body).toBe(200);
    expect(node.json()).toMatchObject({ packId: 'nodejs', status: 'active', series: 1 });
    expect((await get(`/api/v1/agents/${agent.agentId}/packs/nginx/verification`)).json()).toMatchObject({
      status: 'not_found',
      series: 0,
    });
    // Packs without a Level 2 guide have nothing to verify.
    expect((await get(`/api/v1/agents/${agent.agentId}/packs/redis/verification`)).statusCode).toBe(404);
  });
});
