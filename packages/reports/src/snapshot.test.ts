import { describe, expect, it } from 'vitest';
import { fixtureSources } from './fixtures.js';
import { buildSnapshot } from './snapshot.js';
import { DAILY_SECTIONS } from './templates/daily.js';
import { reportWindow } from './window.js';

const w = reportWindow('Europe/Berlin', new Date('2026-10-26T07:00:00Z'));
const section = (s: Awaited<ReturnType<typeof buildSnapshot>>, key: string) =>
  s.sections.find((x) => x.key === key)!;

describe('daily template (inital.md §13)', () => {
  it('has the 12 sections in order with S1–S12 citation IDs', () => {
    expect(DAILY_SECTIONS.map((s) => s.title)).toEqual([
      'Executive summary',
      'Product health',
      'Infrastructure performance',
      'Application performance',
      'User analytics',
      'Database health',
      'Advertising performance',
      'Recent deployments',
      'Security and availability events',
      'Significant anomalies',
      'Suggested actions',
      'Data coverage and missing sources',
    ]);
    expect(DAILY_SECTIONS.map((s) => s.id)).toEqual(DAILY_SECTIONS.map((_, i) => `S${i + 1}`));
  });
});

describe('buildSnapshot (BR-15-01, BR-15-05)', () => {
  it('builds every section deterministically, rounded to one decimal', async () => {
    const s = await buildSnapshot(fixtureSources(), w);
    expect(s.sections).toHaveLength(12);
    expect(section(s, 'infrastructure')).toMatchObject({
      status: 'ok',
      data: { hosts: [{ hostname: 'vps-1', cpuAvg: 72, cpuMax: 97.5, memoryAvg: 61.2, diskMax: 88.1 }] },
    });
    expect(section(s, 'health').data).toEqual({ opened: 3, resolved: 2, openNow: 1, openCritical: 1 });
    expect(section(s, 'summary').data).toMatchObject({ windowHours: 25, localDate: '2026-10-25' });
  });

  it('lists sources that do not exist yet as missing, never as zero', async () => {
    const s = await buildSnapshot(fixtureSources(), w);
    for (const [key, reason] of [
      ['analytics', 'Google Analytics not connected (M13b)'],
      ['ads', 'No ad platform connected'],
      ['deployments', 'No deployment source connected (GitHub, M7)'],
    ])
      expect(section(s, key!)).toMatchObject({ status: 'missing', data: null, reason });
    expect(s.coverage).toContainEqual({
      source: 'User analytics',
      status: 'missing',
      reason: 'Google Analytics not connected (M13b)',
    });
  });

  it('TC-15-06: a source without data is missing with its reason and listed under coverage', async () => {
    const s = await buildSnapshot(
      fixtureSources({
        hosts: async () => null,
        coverage: async () => [{ source: 'Host metrics', status: 'missing', reason: 'No agent reported' }],
      }),
      w,
    );
    expect(section(s, 'infrastructure')).toMatchObject({
      status: 'missing',
      data: null,
      reason: 'No host metrics in this window',
    });
    expect(s.coverage).toContainEqual({
      source: 'Host metrics',
      status: 'missing',
      reason: 'No agent reported',
    });
    expect(JSON.stringify(section(s, 'infrastructure'))).not.toMatch(/"cpu/);
  });

  it('reports deployments from a connected source (M7)', async () => {
    const s = await buildSnapshot(
      fixtureSources({
        deployments: async () => ({
          deployed: 2,
          failed: 1,
          items: [
            {
              kind: 'deployment',
              title: 'Deployed main to production (acme/shop)',
              occurredAt: '2026-10-25T09:00:00.000Z',
            },
            {
              kind: 'deployment_failed',
              title: 'Deployment failed: main to production (acme/shop)',
              occurredAt: '2026-10-25T08:00:00.000Z',
            },
          ],
        }),
      }),
      w,
    );
    expect(section(s, 'deployments')).toMatchObject({ status: 'ok', data: { deployed: 2, failed: 1 } });
    expect(s.coverage.find((c) => c.source === 'Deployments')).toBeUndefined();
  });

  it('flags large changes against the previous day, above a floor', async () => {
    const s = await buildSnapshot(fixtureSources(), w);
    expect(s.anomalies).toContainEqual({
      metric: 'Average CPU',
      previous: 30.1,
      current: 72,
      changePercent: 139.2,
    });
    expect(s.anomalies.find((a) => a.metric === 'Log errors')).toBeUndefined(); // 3 → 6 is under the floor
  });

  it('suggests actions from the numbers only', async () => {
    const s = await buildSnapshot(fixtureSources(), w);
    expect(s.actions).toEqual([
      'Resolve 1 open critical incident.',
      'Free space or grow the disk on vps-1 (88.1 % used).',
      'Investigate https://shop.example.com/health: uptime 98.6 %.',
      'Renew the certificate for https://shop.example.com/health (12 days left).',
    ]);
  });

  it('drops query strings from URLs (BR-15-02)', async () => {
    const s = await buildSnapshot(fixtureSources(), w);
    expect(JSON.stringify(s)).not.toContain('secret-value');
  });
});
