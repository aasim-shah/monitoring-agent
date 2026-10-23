// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddMonitorDialog } from './add-monitor-dialog';
import { MonitorList, type MonitorRow } from './monitor-list';

afterEach(cleanup);

const NOW = new Date('2026-10-23T10:00:00Z');
const row = (over: Partial<MonitorRow> = {}): MonitorRow => ({
  id: 'm1',
  url: 'https://shop.example.com/',
  host: 'shop.example.com',
  intervalSeconds: 60,
  status: 'active',
  pausedReason: null,
  verification: { record: 'TXT', name: 'shop.example.com', value: 'pcp-verify=abc123' },
  last: {
    checkedAt: '2026-10-23T09:59:30Z',
    up: true,
    statusCode: 200,
    error: null,
    totalMs: 245,
    consecutiveFailures: 0,
  },
  tls: { expiresAt: '2026-11-22T10:00:00Z', issuer: "Let's Encrypt" },
  ...over,
});

describe('MonitorList (WB-09 §7)', () => {
  it('shows up, down, verifying, and paused monitors with latency and TLS', () => {
    render(
      <MonitorList
        monitors={[
          row(),
          row({
            id: 'm2',
            url: 'https://api.example.com/',
            last: {
              ...row().last!,
              up: false,
              statusCode: 503,
              consecutiveFailures: 3,
              error: 'receiver answered 503',
            },
          }),
          row({
            id: 'm3',
            url: 'https://new.example.com/',
            status: 'pending_verification',
            last: null,
            tls: null,
          }),
          row({
            id: 'm4',
            url: 'https://old.example.com/',
            status: 'paused',
            pausedReason: 'Domain verification timed out after 24 hours',
          }),
        ]}
        canManage
        now={NOW}
        selected={null}
        onSelect={vi.fn()}
        onVerify={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const up = screen.getByRole('row', { name: /shop.example.com/ });
    expect(within(up).getByText('Up')).toBeInTheDocument();
    expect(within(up).getByText('245 ms')).toBeInTheDocument();
    expect(within(up).getByText('30 days')).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /api.example.com/ })).getByText('Down'),
    ).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /api.example.com/ })).getByText(/503/)).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /new.example.com/ })).getByText('Verifying'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /old.example.com/ })).getByText('Paused'),
    ).toBeInTheDocument();
  });

  it('shows the TXT record to add for an unverified monitor, and checks it', async () => {
    const user = userEvent.setup();
    const onVerify = vi
      .fn()
      .mockResolvedValue({ verified: false, checkedNames: ['new.example.com', 'example.com'] });
    render(
      <MonitorList
        monitors={[row({ status: 'pending_verification', last: null, tls: null })]}
        canManage
        now={NOW}
        selected={null}
        onSelect={vi.fn()}
        onVerify={onVerify}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('pcp-verify=abc123')).toBeInTheDocument();
    expect(screen.getByText(/Add a TXT record on shop.example.com/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check verification' }));
    expect(onVerify).toHaveBeenCalledWith('m1');
    expect(await screen.findByText(/Not found yet on new.example.com, example.com/)).toBeInTheDocument();
  });

  it('hides management actions from members without pack.manage', () => {
    render(
      <MonitorList
        monitors={[row()]}
        canManage={false}
        now={NOW}
        selected={null}
        onSelect={vi.fn()}
        onVerify={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('AddMonitorDialog', () => {
  it('refuses non-http URLs and intervals under 30 s, then submits', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AddMonitorDialog onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    await user.type(screen.getByLabelText('URL'), 'ftp://shop.example.com');
    await user.click(screen.getByRole('button', { name: 'Start monitoring' }));
    expect(await screen.findByText('Enter an http:// or https:// URL')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('URL'));
    await user.type(screen.getByLabelText('URL'), 'https://shop.example.com');
    await user.clear(screen.getByLabelText('Check every (seconds)'));
    await user.type(screen.getByLabelText('Check every (seconds)'), '10');
    await user.click(screen.getByRole('button', { name: 'Start monitoring' }));
    expect(await screen.findByText('Check at most every 30 seconds')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Check every (seconds)'));
    await user.type(screen.getByLabelText('Check every (seconds)'), '60');
    await user.click(screen.getByRole('button', { name: 'Start monitoring' }));
    expect(onSubmit).toHaveBeenCalledWith({ url: 'https://shop.example.com', intervalSeconds: 60 });
  });
});
