import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { agentEnv, enrolledAgent, environmentFor, type EnrolledAgent } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, login, ownerWithOrg, signUpAndVerify, type Owner } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';
import { TelemetryQueryService } from './query.service.js';

let t: TestApp;
let owner: Owner;
let productId: string;
let agent: EnrolledAgent;
const nowS = Math.floor(Date.now() / 1000);

async function importLines(lines: string[]) {
  const vm = inject('vmUrl');
  const res = await fetch(`${vm}/api/v1/import/prometheus`, {
    method: 'POST',
    body: lines.join('\n') + '\n',
  });
  expect(res.ok).toBe(true);
  await fetch(`${vm}/internal/force_flush`);
}

/** Host metrics as the gateway stores them, one sample per minute over `minutes`. */
function hostSeries(labels: Record<string, string>, minutes: number[], idle: number, used: number) {
  const l = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  return minutes.flatMap((m) => {
    const ts = (nowS - m * 60) * 1000;
    return [
      `system_cpu_utilization_ratio{${l},state="idle"} ${idle} ${ts}`,
      `system_cpu_utilization_ratio{${l},state="user"} ${1 - idle} ${ts}`,
      `system_memory_utilization_ratio{${l},state="used"} ${used} ${ts}`,
      `system_filesystem_utilization_ratio{${l},mountpoint="/"} 0.5 ${ts}`,
      `system_network_io_bytes_total{${l},direction="receive",device="eth0"} ${1000 * (60 - m)} ${ts}`,
      `system_network_io_bytes_total{${l},direction="transmit",device="eth0"} ${500 * (60 - m)} ${ts}`,
    ];
  });
}

const get = (url: string, cookie: string) => t.app.inject({ method: 'GET', url, headers: headers(cookie) });

beforeAll(async () => {
  t = await createTestApp({ env: { ...(await agentEnv()), VM_QUERY_URL: inject('vmUrl') } });
  owner = await ownerWithOrg(t);
  let environmentId: string;
  ({ productId, environmentId } = await environmentFor(t, owner));
  agent = await enrolledAgent(t, owner, environmentId);
  const own = {
    tenant_id: owner.orgId,
    product_id: productId,
    environment_id: environmentId,
    agent_id: agent.agentId,
  };
  const minutes = Array.from({ length: 11 }, (_, i) => 40 + i).concat([1, 2, 3, 4, 5]);
  await importLines([
    ...hostSeries(own, minutes, 0.75, 0.4),
    // Another tenant forging this agent's labels (Review Focus #1 at query time).
    ...hostSeries({ ...own, tenant_id: randomUUID() }, minutes, 0, 0.99),
  ]);
});

afterAll(async () => {
  await t?.close();
});

describe('host metrics (WB-04, M6.6)', () => {
  it('returns CPU, memory, disk, and network for the agent, only from its own tenant (TC-04-06)', async () => {
    const res = await get(`/api/v1/agents/${agent.agentId}/metrics?range=1h`, owner.cookie);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.range).toBe('1h');
    const values = (pts: Array<[number, number | null]>) => pts.map((p) => p[1]).filter((v) => v !== null);
    expect(values(body.series.cpu).length).toBeGreaterThan(5);
    expect(values(body.series.cpu).every((v: number) => Math.abs(v - 25) < 0.01)).toBe(true);
    expect(values(body.series.memory).length).toBeGreaterThan(5);
    expect(values(body.series.memory).every((v: number) => Math.abs(v - 40) < 0.01)).toBe(true);
    expect(body.series.disk).toEqual([expect.objectContaining({ mountpoint: '/' })]);
    expect(values(body.series.networkIn).length).toBeGreaterThan(0);
    expect(body.lastSampleAt).toBeDefined();
  });

  it('shows missing minutes as gaps, never zeros (BR-04-07)', async () => {
    const body = (await get(`/api/v1/agents/${agent.agentId}/metrics?range=1h`, owner.cookie)).json();
    const cpu = body.series.cpu as Array<[number, number | null]>;
    expect(cpu.some((p) => p[1] === null)).toBe(true);
    expect(cpu.some((p) => p[1] === 0)).toBe(false);
  });

  it('lists the product infrastructure with current usage', async () => {
    const res = await get(`/api/v1/products/${productId}/infrastructure`, owner.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().hosts).toEqual([
      expect.objectContaining({
        agentId: agent.agentId,
        hostname: 'vps-1',
        cpuPercent: expect.closeTo(25, 1),
        memoryPercent: expect.closeTo(40, 1),
        diskPercent: expect.closeTo(50, 1),
      }),
    ]);
  });

  it('hides other products from product-scoped members and other tenants (Review Focus #3)', async () => {
    const other = await environmentFor(t, owner);
    const email = await signUpAndVerify(t);
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids)
       VALUES ($1, $2, $3, 'analyst', false, ARRAY[$4]::uuid[])`,
      [randomUUID(), owner.orgId, u!.id, other.productId],
    );
    const analyst = await login(t, email);
    expect((await get(`/api/v1/agents/${agent.agentId}/metrics?range=1h`, analyst)).statusCode).toBe(404);
    expect((await get(`/api/v1/products/${productId}/infrastructure`, analyst)).statusCode).toBe(404);
    const stranger = await ownerWithOrg(t);
    expect((await get(`/api/v1/agents/${agent.agentId}/metrics?range=1h`, stranger.cookie)).statusCode).toBe(
      404,
    );
  });

  it('rejects unknown ranges', async () => {
    expect((await get(`/api/v1/agents/${agent.agentId}/metrics?range=99d`, owner.cookie)).statusCode).toBe(
      400,
    );
  });
});

describe('TelemetryQueryService', () => {
  it('reports a range beyond raw retention as partial (TC-04-08)', async () => {
    const svc = t.app.get(TelemetryQueryService);
    const ctx = {
      organizationId: owner.orgId,
      actor: { kind: 'system' as const, jobId: 'test' },
      roles: [],
      productIds: 'all' as const,
      environmentIds: 'all' as const,
      requestId: 'test',
    };
    const res = await svc.query(
      ctx,
      {
        promql: 'avg(system_memory_utilization_ratio)',
        start: new Date((nowS - 20 * 86400) * 1000).toISOString(),
        end: new Date(nowS * 1000).toISOString(),
        stepSeconds: 3600,
      },
      { productId },
    );
    expect(res.completeness).toBe('partial');
    expect(res.gaps[0]).toMatch(/^retention/);
    expect(res.series[0]!.points.some(([, v]) => v === 0)).toBe(false);
  });
});
