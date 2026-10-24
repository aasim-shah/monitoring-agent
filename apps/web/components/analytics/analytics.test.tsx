// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FreshnessLine, KpiResourcePanel, type KpiResource } from './kpi-panel';

afterEach(cleanup);

const point = (day: string, value: number | null, completeness: 'complete' | 'partial' | null) => ({
  day,
  value,
  completeness,
});

const ga4: KpiResource = {
  connectionId: 'c1',
  resourceType: 'google_ga4_property',
  externalId: 'properties/1',
  name: 'Shop web',
  kpis: [
    {
      key: 'ga4.activeUsers',
      label: 'Active users',
      unit: 'count',
      definition: 'Users who had an engaged session.',
      caveats: ['Today is partial.'],
      total: 70,
      points: [point('2026-10-24', 100, 'complete'), point('2026-10-25', 40, 'partial')],
    },
    {
      key: 'ga4.newUsers',
      label: 'New users',
      unit: 'count',
      definition: 'First-time users.',
      caveats: [],
      total: null,
      points: [point('2026-10-24', null, null), point('2026-10-25', null, null)],
    },
    {
      key: 'ga4.engagementRate',
      label: 'Engagement rate',
      unit: 'ratio',
      definition: 'Engaged sessions divided by sessions.',
      caveats: [],
      total: 0.615,
      points: [point('2026-10-24', 0.615, 'complete'), point('2026-10-25', null, null)],
    },
  ],
  breakdown: { sessionsByChannel: [{ channel: 'Organic Search', value: 120 }] },
};

describe('KPI panel (WB-09 UC-09-06, BR-09-05)', () => {
  it('shows totals, "No data" for a missing KPI (never 0), rates as percentages, and marks today partial', () => {
    render(<KpiResourcePanel resource={ga4} />);
    const tiles = screen.getByRole('list', { name: 'Shop web KPIs' });
    expect(within(tiles).getByRole('listitem', { name: 'Active users' })).toHaveTextContent('70');
    expect(within(tiles).getByRole('listitem', { name: 'New users' })).toHaveTextContent('No data');
    expect(within(tiles).getByRole('listitem', { name: 'New users' })).not.toHaveTextContent(/\b0\b/);
    expect(within(tiles).getByRole('listitem', { name: 'Engagement rate' })).toHaveTextContent('61.5%');
    expect(screen.getByText(/Today is partial/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Sessions by channel' })).toHaveTextContent('Organic Search');
  });

  it('a stale source says so with the reason and when it last synced', () => {
    render(
      <FreshnessLine
        name="Google (ops@acme.example)"
        freshness={{
          status: 'stale',
          reason: 'Exhausted property tokens',
          lastSuccessfulSync: '2026-10-25T07:00:00Z',
          lastAttempt: '2026-10-25T09:55:00Z',
          expectedIntervalSeconds: 3600,
        }}
        now={new Date('2026-10-25T10:00:00Z')}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Google (ops@acme.example): stale — Exhausted property tokens. Last synced 3 h ago.',
    );
  });
});
