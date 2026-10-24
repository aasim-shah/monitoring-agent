import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { agentEnv, enrolledAgent, environmentFor, type EnrolledAgent } from '../../../test/agent-helpers.js';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, ownerWithOrg, type Owner } from '../../../test/auth-helpers.js';
import { SERVICE_CHARTS } from './service-metrics.js';

let t: TestApp;
let owner: Owner;
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

function series(labels: Record<string, string>, memory: number) {
  const l = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  return Array.from({ length: 20 }, (_, i) => i + 1).flatMap((m) => {
    const ts = (nowS - m * 60) * 1000;
    const n = 60 - m;
    return [
      `redis_memory_used_bytes{${l}} ${memory} ${ts}`,
      `redis_commands_processed_total{${l}} ${600 * n} ${ts}`,
      `redis_clients_connected{${l}} 3 ${ts}`,
      `redis_keyspace_hits_total{${l}} ${90 * n} ${ts}`,
      `redis_keyspace_misses_total{${l}} ${10 * n} ${ts}`,
      `process_memory_usage_bytes{${l},process_pid="11",process_executable_name="node"} 1000 ${ts}`,
      `process_memory_usage_bytes{${l},process_pid="12",process_executable_name="node"} 2000 ${ts}`,
      // Two error lines a minute in the Redis log, counted by the collector (M11.2).
      `log_lines_total{${l},service="redis",level="error"} ${2 * n} ${ts}`,
      `log_lines_total{${l},service="redis",level="info"} ${50 * n} ${ts}`,
    ];
  });
}

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: headers(owner.cookie) });
const enable = (packId: string, settings: Record<string, unknown>) =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1/agents/${agent.agentId}/packs`,
    headers: headers(owner.cookie),
    payload: { packId, settings },
  });

beforeAll(async () => {
  t = await createTestApp({ env: { ...(await agentEnv()), VM_QUERY_URL: inject('vmUrl') } });
  owner = await ownerWithOrg(t);
  const { productId, environmentId } = await environmentFor(t, owner);
  agent = await enrolledAgent(t, owner, environmentId);
  const own = {
    tenant_id: owner.orgId,
    product_id: productId,
    environment_id: environmentId,
    agent_id: agent.agentId,
  };
  await importLines([...series(own, 5_000_000), ...series({ ...own, tenant_id: randomUUID() }, 99)]);
  // A first error burst: the scraped counter appears at 3, never at 0 (M11.2).
  const burst = Object.entries({ ...own, service: 'nginx', level: 'error' })
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  await importLines([1, 2, 3].map((m) => `log_lines_total{${burst}} 3 ${(nowS - m * 30) * 1000}`));
  await enable('redis', { endpoint: '127.0.0.1:6379' });
  await enable('nginx', { endpoint: 'http://127.0.0.1/nginx_status' });
  await enable('nodejs', {});
});

afterAll(async () => {
  await t?.close();
});

const values = (pts: Array<[number, number | null]>) =>
  pts.map((p) => p[1]).filter((v): v is number => v !== null);

describe('service charts (WB-11, fixed PromQL per pack)', () => {
  it('has a chart template for every pack', () => {
    expect(Object.keys(SERVICE_CHARTS).sort()).toEqual(
      [
        'kafka',
        'mongodb',
        'mysql',
        'nginx',
        'nodejs',
        'postgresql',
        'redis',
        'redis-exporter',
        'kafka-exporter',
      ].sort(),
    );
  });

  it('charts log errors per minute for every pack that has log files', () => {
    for (const pack of ['redis', 'postgresql', 'mysql', 'mongodb', 'kafka', 'nginx']) {
      const chart = SERVICE_CHARTS[pack]!.find((c) => c.key === 'logErrors');
      expect(chart, pack).toBeDefined();
      expect(chart!.promql).toContain(`service="${pack}",level="error"`);
    }
    expect(SERVICE_CHARTS.nodejs!.some((c) => c.key === 'logErrors')).toBe(false);
  });

  it('returns the Redis charts from the agent own tenant only', async () => {
    const res = await get(`/api/v1/agents/${agent.agentId}/services/redis/metrics?range=1h`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const chart = (key: string) => body.charts.find((c: { key: string }) => c.key === key);
    expect(body.charts.map((c: { key: string }) => c.key)).toEqual([
      'memory',
      'ops',
      'clients',
      'hitRatio',
      'logErrors',
    ]);
    const memory = values(chart('memory').series[0].points);
    expect(memory.length).toBeGreaterThan(5);
    expect(memory.every((v) => v === 5_000_000)).toBe(true);
    expect(chart('memory').unit).toBe('bytes');
    expect(values(chart('ops').series[0].points).every((v) => Math.abs(v - 10) < 0.01)).toBe(true);
    expect(values(chart('hitRatio').series[0].points).every((v) => Math.abs(v - 90) < 0.01)).toBe(true);
    const errors = values(chart('logErrors').series[0].points);
    expect(errors.length).toBeGreaterThan(5);
    // The imported counter starts at 80 (increase_pure counts that at the series start) and
    // ends a minute ago; between those edges it reads 2 errors a minute.
    const steady = errors.slice(5, -1);
    expect(steady.length).toBeGreaterThan(5);
    expect(steady.every((v) => Math.abs(v - 2) < 0.01)).toBe(true);
    expect(chart('logErrors').title).toBe('Log errors per minute');
  });

  it('counts the first burst of errors of a new counter', async () => {
    const body = (await get(`/api/v1/agents/${agent.agentId}/services/nginx/metrics?range=15m`)).json();
    const chart = body.charts.find((c: { key: string }) => c.key === 'logErrors');
    expect(Math.max(...values(chart.series[0].points))).toBeGreaterThan(0);
  });

  it('labels one series per Node.js process', async () => {
    const body = (await get(`/api/v1/agents/${agent.agentId}/services/nodejs/metrics?range=1h`)).json();
    const memory = body.charts.find((c: { key: string }) => c.key === 'memory');
    expect(memory.series.map((s: { label: string }) => s.label).sort()).toEqual([
      'node (pid 11)',
      'node (pid 12)',
    ]);
  });

  it('refuses packs that are not enabled, unknown packs, and bad ranges', async () => {
    expect((await get(`/api/v1/agents/${agent.agentId}/services/postgresql/metrics`)).statusCode).toBe(404);
    expect((await get(`/api/v1/agents/${agent.agentId}/services/docker/metrics`)).statusCode).toBe(404);
    expect((await get(`/api/v1/agents/${agent.agentId}/services/redis/metrics?range=2y`)).statusCode).toBe(
      400,
    );
  });
});
