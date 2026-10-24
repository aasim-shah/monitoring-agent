// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LimitBanner, UsageView, type UsageData } from './usage-view';

afterEach(cleanup);

const data = (over: Partial<UsageData> = {}): UsageData => ({
  range: '24h',
  buckets: [
    { start: '2026-10-25T09:00:00Z', samples: 216000, activeSeries: 1200, refusedRequests: 0 },
    { start: '2026-10-25T10:00:00Z', samples: 180000, activeSeries: 1250, refusedRequests: 3 },
  ],
  totals: { samples: 396000, activeSeries: 1250, refusedRequests: 3 },
  limits: { agentSeries: 20000, tenantSeries: 200000, agentSamplesPerSecond: 10000 },
  overLimitSince: null,
  ...over,
});

describe('usage (M10.6, spec §11.6)', () => {
  it('shows active series against the limit, samples, and refused requests', () => {
    render(<UsageView data={data()} />);
    const tiles = screen.getByRole('list', { name: 'Usage totals' });
    expect(within(tiles).getByRole('listitem', { name: 'Active series' })).toHaveTextContent(
      '1,250 of 200,000',
    );
    expect(within(tiles).getByRole('listitem', { name: 'Samples' })).toHaveTextContent('396,000');
    expect(within(tiles).getByRole('listitem', { name: 'Refused requests' })).toHaveTextContent('3');
    expect(screen.getByText(/20,000 series per agent/)).toBeInTheDocument();
  });

  it('warns while telemetry is being refused, and says nothing is dropped silently', () => {
    render(<LimitBanner since="2026-10-25T10:02:00Z" usageHref="/orgs/o/usage" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Telemetry limit reached/);
    expect(screen.getByRole('alert')).toHaveTextContent(/existing series keep flowing/i);
    expect(screen.getByRole('link', { name: 'See usage' })).toHaveAttribute('href', '/orgs/o/usage');
  });
});
