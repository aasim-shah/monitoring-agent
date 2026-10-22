// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricChart, toRows } from './metric-chart';

afterEach(cleanup);

const t0 = 1_792_000_000;

describe('toRows', () => {
  it('keeps missing samples as null so the line breaks (BR-04-07, TC-04-13)', () => {
    const rows = toRows([
      {
        key: 'in',
        label: 'In',
        points: [
          [t0, 5],
          [t0 + 60, null],
          [t0 + 120, 7],
        ],
      },
      {
        key: 'out',
        label: 'Out',
        points: [
          [t0, 1],
          [t0 + 60, 2],
        ],
      },
    ]);
    expect(rows).toEqual([
      { t: t0, in: 5, out: 1 },
      { t: t0 + 60, in: null, out: 2 },
      { t: t0 + 120, in: 7, out: null },
    ]);
  });
});

describe('MetricChart', () => {
  it('names a single series in the title, with no legend', () => {
    render(
      <MetricChart title="CPU" unit="percent" series={[{ key: 'cpu', label: 'CPU', points: [[t0, 25]] }]} />,
    );
    expect(screen.getByRole('heading', { name: 'CPU' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Legend' })).toBeNull();
  });

  it('shows a legend for several series and a table where gaps read "no data", never 0', () => {
    render(
      <MetricChart
        title="Network"
        unit="bytesPerSecond"
        series={[
          {
            key: 'in',
            label: 'In',
            points: [
              [t0, 2048],
              [t0 + 60, null],
            ],
          },
          {
            key: 'out',
            label: 'Out',
            points: [
              [t0, 512],
              [t0 + 60, 1024],
            ],
          },
        ]}
      />,
    );
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getByText('In')).toBeInTheDocument();
    expect(within(legend).getByText('Out')).toBeInTheDocument();
    const table = screen.getByRole('table', { hidden: true });
    expect(within(table).getByText('2.0 KB/s')).toBeInTheDocument();
    expect(within(table).getAllByText('no data')).toHaveLength(1);
    expect(within(table).queryByText('0 B/s')).toBeNull();
  });

  it('says so when there is no data at all', () => {
    render(<MetricChart title="Disk" unit="percent" series={[]} />);
    expect(screen.getByText(/No data in this range/)).toBeInTheDocument();
  });
});
