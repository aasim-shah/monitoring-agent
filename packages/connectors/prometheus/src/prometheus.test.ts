import type { ExecutionContext } from '@pcp/connector-sdk';
import { describe, expect, it } from 'vitest';
import { createPrometheusConnector } from './index.js';

const ctx = (creds: Record<string, string> = {}): ExecutionContext => ({
  authenticatedOrganizationId: 'org',
  connectionId: 'conn-1',
  executionLocation: 'cloud',
  requestId: 'r',
  deadline: new Date(Date.now() + 30_000).toISOString(),
  config: { baseUrl: 'https://prom.example.com' },
  credentials: async () => creds,
});

function fakeFetch(answer: (u: URL) => { status: number; body: unknown } | undefined) {
  const calls: Array<{ path: string; auth: string | null }> = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    calls.push({ path: `${u.pathname}${u.search}`, auth: new Headers(init.headers).get('authorization') });
    const a = answer(u) ?? { status: 404, body: { status: 'error' } };
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const success = (data: unknown) => ({ status: 200, body: { status: 'success', data } });

describe('Prometheus Mode A (WB-06 UC-06-07/08, BR-06-03)', () => {
  it('validates through buildinfo, with bearer or basic auth', async () => {
    const { fetch, calls } = fakeFetch((u) =>
      u.pathname === '/api/v1/status/buildinfo' ? success({ version: '2.53.0' }) : undefined,
    );
    const c = createPrometheusConnector({ fetch });
    expect(await c.validate(ctx({ bearerToken: 'tok' }))).toEqual({
      ok: true,
      accountId: 'Prometheus 2.53.0',
    });
    await c.validate(ctx({ username: 'u', password: 'p' }));
    expect(calls.map((x) => x.auth)).toEqual([
      'Bearer tok',
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    ]);
  });

  it('TC-06-06: turns targets into host and job observations with the instance IP', async () => {
    const { fetch } = fakeFetch((u) =>
      u.pathname === '/api/v1/targets'
        ? success({
            activeTargets: [
              {
                labels: { instance: '10.0.0.5:9100', job: 'node' },
                health: 'up',
                scrapeUrl: 'http://10.0.0.5:9100/metrics',
              },
              {
                labels: { instance: 'api-1.internal:8080', job: 'orders-api' },
                health: 'down',
                scrapeUrl: 'http://api-1.internal:8080/metrics',
              },
            ],
          })
        : u.pathname === '/api/v1/rules'
          ? success({ groups: [{ rules: [{}, {}] }] })
          : undefined,
    );
    const page = await createPrometheusConnector({ fetch }).discover!(ctx());
    const targets = page.observations.filter((o) => o.resourceType === 'prometheus_target');
    expect(targets.map((t) => t.attributes)).toEqual([
      expect.objectContaining({
        name: '10.0.0.5:9100',
        instance: '10.0.0.5:9100',
        job: 'node',
        health: 'up',
        ip: '10.0.0.5',
        hostname: null,
      }),
      expect.objectContaining({
        instance: 'api-1.internal:8080',
        job: 'orders-api',
        health: 'down',
        ip: null,
        hostname: 'api-1.internal',
      }),
    ]);
  });

  it('caps discovery at 1,000 targets (Review Focus #3)', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({
      labels: { instance: `10.1.${Math.floor(i / 250)}.${i % 250}:9100`, job: 'node' },
      health: 'up',
    }));
    const { fetch } = fakeFetch((u) =>
      u.pathname === '/api/v1/targets' ? success({ activeTargets: many }) : success({ groups: [] }),
    );
    const page = await createPrometheusConnector({ fetch }).discover!(ctx());
    expect(page.observations.filter((o) => o.resourceType === 'prometheus_target')).toHaveLength(1000);
  });

  it('TC-07: queries on demand within the hosted limits, refusing an over-limit query before sending it', async () => {
    const { fetch, calls } = fakeFetch((u) =>
      u.pathname === '/api/v1/query_range'
        ? success({
            resultType: 'matrix',
            result: [
              {
                metric: { job: 'node' },
                values: [
                  [1792800000, '0.5'],
                  [1792800060, 'NaN'],
                ],
              },
            ],
          })
        : undefined,
    );
    const c = createPrometheusConnector({ fetch });
    const r = await c.collect!(ctx(), {
      promql: 'up',
      start: '2026-10-24T00:00:00Z',
      end: '2026-10-24T00:01:00Z',
      stepSeconds: 60,
    });
    expect(r.series).toEqual([
      {
        labels: { job: 'node' },
        points: [
          [1792800000, 0.5],
          [1792800060, null],
        ],
      },
    ]);
    const before = calls.length;
    await expect(
      c.collect!(ctx(), {
        promql: 'up',
        start: '2026-08-01T00:00:00Z',
        end: '2026-10-24T00:00:00Z',
        stepSeconds: 60,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_config' });
    await expect(
      c.collect!(ctx(), {
        promql: 'up',
        start: '2026-10-20T00:00:00Z',
        end: '2026-10-24T00:00:00Z',
        stepSeconds: 15,
      }),
    ).rejects.toThrow(/narrow the range/);
    expect(calls.length).toBe(before);
  });
});
