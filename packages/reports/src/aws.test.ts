import { describe, it, expect } from 'vitest';
import { buildSnapshot, type AwsStats } from './snapshot.js';
import { fixtureSources } from './fixtures.js';
import { reportWindow } from './window.js';
import { renderReport, sectionLines } from './render.js';
const w = reportWindow('Asia/Karachi', new Date('2026-10-26T03:00:00Z'));
function aws(value: number, partial = false): AwsStats {
  return {
    day: '2026-10-25',
    timezone: 'UTC',
    gaps: partial ? ['Billing read denied'] : [],
    resources: [
      {
        name: 'AWS account costs 123456789012 (shared, not product-attributed)',
        externalId: 'aws-cost:123456789012',
        resourceType: 'aws_cost_account',
        partial,
        fetchedAt: '2026-10-26T02:00:00Z',
        values: [{ metric: 'cost_usd', label: 'Unblended cost', value, unit: 'USD' }],
        costByService: [{ service: 'Amazon S3', value }],
      },
    ],
  };
}
describe('AWS reports', () => {
  it('keeps UTC attribution and service costs in the web, email, and delivery snapshot', async () => {
    const snapshot = await buildSnapshot(fixtureSources({ aws: async () => aws(1.23, true) }), w);
    const section = snapshot.sections.find((s) => s.key === 'aws')!;
    expect(section.id).toBe('S13');
    expect(snapshot.sections.find((s) => s.key === 'coverage')?.id).toBe('S12');
    expect(sectionLines(section).join(' ')).toContain('00:00–24:00 UTC');
    expect(snapshot.coverage).toContainEqual(
      expect.objectContaining({ source: 'AWS (UTC daily buckets)', status: 'partial' }),
    );
    const result = renderReport(
      { snapshot, productName: 'shop', narrative: null, narrativeStatus: 'disabled', late: false },
      'https://example.com/report',
    );
    expect(result.text).toContain('Amazon S3: 1.23 USD');
    expect(result.html).toContain('Amazon S3');
    expect(result.html).toContain('not product-attributed');
  });
  it('calculates cost changes deterministically and avoids anomaly claims for provisional periods', async () => {
    const snapshot = await buildSnapshot(
      fixtureSources({ aws: async (period) => aws(period.localDate === w.localDate ? 20 : 10) }),
      w,
    );
    expect(snapshot.anomalies).toContainEqual(
      expect.objectContaining({ previous: 10, current: 20, changePercent: 100 }),
    );
    const provisional = await buildSnapshot(
      fixtureSources({ aws: async (period) => aws(period.localDate === w.localDate ? 20 : 10, true) }),
      w,
    );
    expect(provisional.anomalies.some((a) => a.metric.includes('Unblended cost'))).toBe(false);
  });
});
