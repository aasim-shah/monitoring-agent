import { describe, expect, it } from 'vitest';
import { sectionLines } from './render.js';
import type { Section } from './snapshot.js';

const section = (key: string, data: unknown): Section =>
  ({ id: 'S0', key, title: key, status: 'ok', data, reason: null }) as unknown as Section;

describe('daily report lines with 24 h activity and trends (M15b)', () => {
  it('lists new records per database with the tables that grew most', () => {
    const lines = sectionLines(
      section('databases', {
        databases: [
          {
            name: 'corebyte-db',
            provider: 'mongodb',
            status: 'healthy',
            ok: true,
            activity: {
              baseline: 'ok',
              approximate: true,
              rowsAdded: 58,
              sizeBytes: 3_500_000,
              sizeChangeBytes: 120_000,
              top: [
                { name: 'orders', added: 50, total: 4310 },
                { name: 'audit', added: 8, total: 20, isNew: true },
              ],
            },
          },
          {
            name: 'shop',
            provider: 'postgres',
            status: 'healthy',
            ok: true,
            activity: {
              baseline: 'none',
              approximate: false,
              rowsAdded: null,
              sizeBytes: 1000,
              sizeChangeBytes: null,
              top: [],
            },
          },
          {
            name: 'legacy',
            provider: 'postgres',
            status: 'healthy',
            ok: true,
            activity: {
              baseline: 'reset',
              approximate: false,
              rowsAdded: null,
              sizeBytes: 1000,
              sizeChangeBytes: 0,
              top: [],
            },
          },
        ],
      }),
    );
    expect(lines).toEqual([
      'corebyte-db (mongodb): healthy; 58 new records in 24 h (estimated); size 3.3 MB (+117.2 KB)',
      '  orders: +50 (now 4,310)',
      '  audit: new, 20 records',
      'shop (postgres): healthy; new records: no baseline yet, counted from tomorrow; size 1000 B',
      'legacy (postgres): healthy; new records: statistics were reset in this window; size 1000 B (+0 B)',
    ]);
  });

  it('shows website speed and failed checks with the change against yesterday', () => {
    const lines = sectionLines(
      section('availability', {
        websites: [
          {
            url: 'https://getrestro.com/',
            uptimePercent: 100,
            tlsDays: 60,
            avgMs: 180,
            p95Ms: 420,
            failedChecks: 0,
            previousUptimePercent: 99.3,
            previousAvgMs: 160,
          },
          { url: 'https://apis.getrestro.com/', uptimePercent: null, tlsDays: null },
        ],
      }),
    );
    expect(lines).toEqual([
      'https://getrestro.com/: uptime 100.0 % (▲ 1%), avg 180 ms (▲ 13%), p95 420 ms, 0 failed checks, certificate 60 days left',
      'https://apis.getrestro.com/: uptime no data',
    ]);
  });

  it('labels values from an earlier published day and trends against the day before', () => {
    const lines = sectionLines(
      section('analytics', {
        reportDay: '2026-10-25',
        resources: [
          {
            name: 'Shop web',
            source: 'GA4',
            partial: true,
            values: [
              {
                label: 'Active users',
                value: 120,
                unit: 'count',
                day: '2026-10-25',
                previous: 100,
                previousDay: '2026-10-24',
              },
              { label: 'Sessions', value: null, unit: 'count', day: null, previous: null, previousDay: null },
            ],
          },
          {
            name: 'getrestro.com',
            source: 'Search Console',
            partial: false,
            values: [
              {
                label: 'Search clicks',
                value: 42,
                unit: 'count',
                day: '2026-10-23',
                previous: 44,
                previousDay: '2026-10-22',
              },
            ],
          },
        ],
        firebaseApps: ['Shop Android'],
      }),
    );
    expect(lines).toEqual([
      'Shop web (GA4, partial day): Active users 120 (▲ 20% vs 2026-10-24), Sessions no data',
      'getrestro.com (Search Console): Search clicks 42 on 2026-10-23 (▼ 5% vs 2026-10-22)',
      'Firebase apps: Shop Android (crash data needs the Crashlytics BigQuery export)',
    ]);
  });
});
