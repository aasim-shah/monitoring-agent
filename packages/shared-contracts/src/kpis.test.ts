import { describe, expect, it } from 'vitest';
import { KPI_DEFINITIONS, aggregate, kpiValue, sumKpis, kpisFor } from './kpis.js';

describe('KPI catalog (WB-09 UC-09-05, BR-09-03)', () => {
  it('every KPI has a definition, unit, window, source, timezone note, and caveats', () => {
    for (const d of Object.values(KPI_DEFINITIONS)) {
      expect(d.label.length, d.key).toBeGreaterThan(0);
      expect(d.definition.length, d.key).toBeGreaterThan(10);
      expect(['count', 'percent', 'ratio', 'position'], d.key).toContain(d.unit);
      expect(d.window, d.key).toBe('day');
      expect(d.source.length, d.key).toBeGreaterThan(0);
      expect(d.timezone.length, d.key).toBeGreaterThan(0);
      expect(Array.isArray(d.caveats), d.key).toBe(true);
    }
    expect(kpisFor('google_ga4_property').map((d) => d.metric)).toEqual([
      'activeUsers',
      'newUsers',
      'sessions',
      'screenPageViews',
      'engagementRate',
      'keyEvents',
    ]);
  });

  it('aggregates a range by each KPI rule; missing days stay missing, never zero (BR-09-05)', () => {
    const sessions = KPI_DEFINITIONS['ga4.sessions']!;
    expect(aggregate(sessions, [10, null, 20])).toBe(30);
    expect(aggregate(KPI_DEFINITIONS['ga4.activeUsers']!, [10, null, 20])).toBe(15);
    expect(aggregate(sessions, [null, null])).toBeNull();
    expect(aggregate(sessions, [])).toBeNull();
  });

  it('refuses to add incomparable populations: GA4 users plus Play users (Review Focus #4)', () => {
    const ga4 = kpiValue('ga4_users', 120);
    const play = kpiValue('play_users', 80);
    expect(sumKpis([ga4, kpiValue('ga4_users', 30)])).toEqual({ population: 'ga4_users', value: 150 });
    // @ts-expect-error — different populations do not type-check together.
    expect(() => sumKpis<'ga4_users'>([ga4, play])).toThrow(/incomparable_kpis/);
    expect(() => sumKpis([ga4, play] as never)).toThrow(/incomparable_kpis/);
  });
});
