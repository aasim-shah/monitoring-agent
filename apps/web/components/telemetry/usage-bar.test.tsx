// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageBar } from './usage-bar';

afterEach(cleanup);

describe('UsageBar', () => {
  it('shows the percentage as text and as a meter', () => {
    render(<UsageBar label="CPU" percent={42.4} />);
    const meter = screen.getByRole('meter', { name: 'CPU' });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('shows "no data" instead of an empty bar when the value is missing', () => {
    render(<UsageBar label="Disk" percent={null} />);
    expect(screen.getByText('no data')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('flags high usage with a label, not color alone', () => {
    render(<UsageBar label="Memory" percent={95} />);
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });
});
