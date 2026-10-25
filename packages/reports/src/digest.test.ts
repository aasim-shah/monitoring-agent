import { describe, expect, it } from 'vitest';
import { digest, metricValues, plainNarrative } from './digest.js';
import { fixtureSources } from './fixtures.js';
import { buildSnapshot, type AnalyticsStats, type Snapshot } from './snapshot.js';
import { reportWindow } from './window.js';

const w = reportWindow('Asia/Karachi', new Date('2026-10-25T03:00:00Z'));

/** The 24 Oct production report: a quiet day, one GA4 property, one busy and two idle sites. */
const pharmacy: AnalyticsStats = {
  reportDay: '2026-10-24',
  resources: [
    {
      name: 'runmypharmacy',
      source: 'GA4',
      partial: false,
      values: [
        { label: 'Active users', unit: 'count', value: 6, previous: 8, previousDay: '2026-10-23' },
        { label: 'New users', unit: 'count', value: 6, previous: 8, previousDay: '2026-10-23' },
        { label: 'Views', unit: 'count', value: 18, previous: 14, previousDay: '2026-10-23' },
        { label: 'Engagement rate', unit: 'ratio', value: 0.5, previous: 0.5, previousDay: '2026-10-23' },
      ],
    },
    {
      name: 'runmypharmacy.com',
      source: 'Search Console',
      partial: true,
      values: [
        { label: 'Search clicks', unit: 'count', value: 3, previous: 4, previousDay: '2026-10-23' },
        { label: 'Search impressions', unit: 'count', value: 157, previous: 240, previousDay: '2026-10-23' },
        {
          label: 'Average position',
          unit: 'position',
          value: 25.90445859872612,
          previous: 22.51666666666667,
          previousDay: '2026-10-23',
        },
      ],
    },
    {
      name: 'aasimshah.com',
      source: 'Search Console',
      partial: true,
      values: [
        { label: 'Search clicks', unit: 'count', value: 0, previous: 0, previousDay: '2026-10-23' },
        { label: 'Search impressions', unit: 'count', value: 0, previous: 0, previousDay: '2026-10-23' },
      ],
    },
  ],
};

const quietDay = () =>
  buildSnapshot(
    fixtureSources({
      incidents: async () => ({ opened: 0, resolved: 0, openNow: 0, openCritical: 0 }),
      hosts: async () => [
        { hostname: 'new-fyrestorage-tesing', cpuAvg: 1.4, cpuMax: 32.1, memoryAvg: 49.5, diskMax: 30.2 },
      ],
      websites: async () => [
        {
          url: 'https://runmypharmacy.com/',
          uptimePercent: 100,
          tlsDays: 61,
          avgMs: 340,
          previousAvgMs: 330,
        },
      ],
      logErrors: async () => null,
      analytics: async () => pharmacy,
    }),
    w,
  );

describe('report digest: the plain, card-based reading of a snapshot', () => {
  it('calls a quiet day "Worth a look" only for the Google drop, with a plain next step', async () => {
    const d = digest(await quietDay(), null);
    expect(d.status).toEqual({ tone: 'watch', label: 'Worth a look' });
    expect(d.watch).toHaveLength(1);
    expect(d.watch[0]!.title).toBe('Fewer search impressions on runmypharmacy.com');
    expect(d.watch[0]!.text).toContain('157, down from 240');
    expect(d.watch[0]!.text).toContain('position 25.9 (was 22.5)');
  });

  it('says "All good" when nothing moved and nothing is open', async () => {
    const s = await buildSnapshot(
      fixtureSources({
        incidents: async () => ({ opened: 0, resolved: 0, openNow: 0, openCritical: 0 }),
        hosts: async () => [{ hostname: 'a', cpuAvg: 5, cpuMax: 9, memoryAvg: 30, diskMax: 40 }],
        websites: async () => [{ url: 'https://a.example/', uptimePercent: 100, tlsDays: 80 }],
        logErrors: async () => ({ errors: 0, warnings: 0 }),
      }),
      w,
    );
    expect(digest(s, null).status).toEqual({ tone: 'good', label: 'All good' });
  });

  it('needs attention when an incident is open or a disk is nearly full', async () => {
    const d = digest(
      await buildSnapshot(fixtureSources(), reportWindow('Europe/Berlin', new Date('2026-10-26T07:00:00Z'))),
      null,
    );
    expect(d.status.tone).toBe('attention');
    expect(d.watch.map((x) => x.title)).toEqual(
      expect.arrayContaining(['1 incident open', 'vps-1 disk is 88% full']),
    );
  });

  it('leads with visitors, page views, Google, and incidents, each with its change', async () => {
    const d = digest(await quietDay(), null);
    expect(d.kpis.map((k) => [k.label, k.display])).toEqual([
      ['Visitors', '6'],
      ['Page views', '18'],
      ['Shown on Google', '157'],
      ['Incidents', '0'],
    ]);
    expect(d.kpis[0]!.change).toMatchObject({ text: '▼ 25%', good: false, against: 'vs Fri' });
    expect(d.kpis[1]!.change).toMatchObject({ text: '▲ 29%', good: true });
  });

  it('fills the four cards from servers and websites when Google is not connected', async () => {
    const d = digest(await buildSnapshot(fixtureSources(), w), null);
    expect(d.kpis.map((k) => k.label)).toEqual(['Incidents', 'Uptime', 'Server CPU', 'Log errors']);
  });

  it('hides properties with no activity and lists them as quiet', async () => {
    const d = digest(await quietDay(), null);
    expect(d.analytics.map((a) => a.name)).toEqual(['runmypharmacy', 'runmypharmacy.com']);
    expect(d.quiet).toEqual(['aasimshah.com']);
  });

  it('rounds long decimals and never shows citation codes', async () => {
    const s = await quietDay();
    const sc = digest(s, null).analytics[1]!;
    expect(sc.rows).toContainEqual(['Average position', '25.9 (was 22.5)']);
    expect(plainNarrative('Views rose to 18 [S5]. Uptime held [S1, S2].')).toBe(
      'Views rose to 18. Uptime held.',
    );
    expect(digest(s, 'No incidents [S2].').summary).toBe('No incidents.');
  });

  it('writes its own plain summary when there is no AI narrative', async () => {
    expect(digest(await quietDay(), null).summary).toBe(
      'No incidents. Your website was up all day. Visitors 6, down 25% from the day before. 1 thing is worth a look.',
    );
  });

  it('draws 7-day lines from earlier reports, oldest first, ending today', async () => {
    const s: Snapshot = {
      ...(await quietDay()),
      history: [
        { day: '2026-10-22', values: { 'ga:runmypharmacy:Active users': 4 } },
        { day: '2026-10-23', values: { 'ga:runmypharmacy:Active users': 8 } },
      ],
    };
    expect(digest(s, null).kpis[0]!.series).toEqual([4, 8, 6]);
    expect(digest(await quietDay(), null).kpis[0]!.series).toEqual([6]);
  });

  it('keeps the values a later report needs for its trend lines', async () => {
    const v = metricValues(await quietDay());
    expect(v['ga:runmypharmacy:Active users']).toBe(6);
    expect(v['incidents.opened']).toBe(0);
    expect(v['web:https://runmypharmacy.com/:uptime']).toBe(100);
    expect(v['host:new-fyrestorage-tesing:cpu']).toBe(1.4);
  });

  it('lists sources that are not connected', async () => {
    expect(digest(await quietDay(), null).notConnected).toEqual(
      expect.arrayContaining(['Advertising', 'Deployments']),
    );
  });
});
