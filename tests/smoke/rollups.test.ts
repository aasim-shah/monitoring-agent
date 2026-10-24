import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRETS, compose, envFile, repoRoot, run } from './compose.js';

// Long-term rollups (M18.4): the rules are valid, and a replay over imported samples lands 5-minute
// aggregates in the long-term store with every label (tenant_id first) kept.
const NET = `pcp-rollups-test-${process.pid}`;
const RAW = `${NET}-raw`;
const LONG = `${NET}-long`;
const VM = 'victoriametrics/victoria-metrics:v1.126.0';
const VMALERT = 'victoriametrics/vmalert:v1.126.0';
const RULES = `${repoRoot}infrastructure/telemetry/rollups`;

const vm = (name: string, port: number) =>
  run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--network',
    NET,
    '--memory',
    '256m',
    '-p',
    `127.0.0.1:${port}:8428`,
    VM,
  ]);

async function until<T>(f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  await run('docker', ['network', 'create', NET]);
  expect((await vm(RAW, 18431)).status).toBe(0);
  expect((await vm(LONG, 18432)).status).toBe(0);
  for (const port of [18431, 18432])
    await until(async () => ((await fetch(`http://127.0.0.1:${port}/health`)).ok ? true : undefined));
}, 120_000);

afterAll(async () => {
  await run('docker', ['rm', '-f', RAW, LONG]);
  await run('docker', ['network', 'rm', NET]);
});

describe('long-term rollups (M18.4)', () => {
  it('the rollups profile runs both services unpublished and memory-capped', async () => {
    const r = await compose('pcp-smoke-config', envFile(SECRETS), [
      '--profile',
      'rollups',
      'config',
      '--format',
      'json',
    ]);
    expect(r.status, r.stderr).toBe(0);
    const services = JSON.parse(r.stdout).services as Record<
      string,
      { ports?: unknown[]; deploy?: { resources?: { limits?: { memory?: string } } } }
    >;
    for (const name of ['victoriametrics-longterm', 'vmalert-rollups']) {
      expect(services[name]?.ports ?? []).toEqual([]);
      expect(services[name]?.deploy?.resources?.limits?.memory).toBeTruthy();
    }
    const plain = await compose('pcp-smoke-config', envFile(SECRETS), ['config', '--format', 'json']);
    expect(Object.keys(JSON.parse(plain.stdout).services)).not.toContain('victoriametrics-longterm');
  });

  it('vmalert accepts the rollup rules', async () => {
    const r = await run('docker', [
      'run',
      '--rm',
      '-v',
      `${RULES}:/rules:ro`,
      VMALERT,
      '-dryRun',
      '-rule=/rules/*.yaml',
    ]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
  });

  it('a replay writes 5-minute aggregates with tenant labels to the long-term store', async () => {
    const t0 = Math.floor(Date.now() / 1000 / 300) * 300 - 3600;
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      const ts = (t0 + i * 30) * 1000;
      lines.push(
        `system_cpu_utilization_ratio{tenant_id="t-1",product_id="p-1",agent_id="a-1",state="idle"} ${i % 2 ? 0.8 : 0.6} ${ts}`,
      );
      lines.push(
        `system_network_io_bytes_total{tenant_id="t-1",product_id="p-1",agent_id="a-1",direction="receive",device="eth0"} ${i * 1000} ${ts}`,
      );
    }
    const imported = await fetch('http://127.0.0.1:18431/api/v1/import/prometheus', {
      method: 'POST',
      body: lines.join('\n'),
    });
    expect(imported.status).toBe(204);
    await fetch('http://127.0.0.1:18431/internal/force_flush');
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const replay = await run('docker', [
      'run',
      '--rm',
      '--network',
      NET,
      '-v',
      `${RULES}:/rules:ro`,
      VMALERT,
      '-rule=/rules/*.yaml',
      `-datasource.url=http://${RAW}:8428`,
      `-remoteWrite.url=http://${LONG}:8428`,
      `-replay.timeFrom=${iso(t0 + 300)}`,
      `-replay.timeTo=${iso(t0 + 1800)}`,
      '-replay.disableProgressBar',
    ]);
    expect(replay.status, replay.stderr.slice(-2000)).toBe(0);
    const series = await until(async () => {
      await fetch('http://127.0.0.1:18432/internal/force_flush');
      const q = new URLSearchParams({
        query: 'system_cpu_utilization_ratio',
        start: String(t0),
        end: String(t0 + 3600),
        step: '300s',
      });
      const body = (await (await fetch(`http://127.0.0.1:18432/api/v1/query_range?${q}`)).json()) as {
        data: { result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
      };
      return body.data.result.length ? body.data.result : undefined;
    });
    expect(series[0]!.metric).toMatchObject({
      tenant_id: 't-1',
      product_id: 'p-1',
      agent_id: 'a-1',
      state: 'idle',
    });
    expect(Number(series[0]!.values[0]![1])).toBeCloseTo(0.7, 1);
  });
});
