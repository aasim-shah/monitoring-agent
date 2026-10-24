// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@pcp/api-client';
import { LogSearch } from './log-search';
import { RetainLogsToggle } from '../services/retain-logs-toggle';

afterEach(cleanup);

describe('LogSearch (M18.1, UC-12-04)', () => {
  it('searches the retained logs and lists lines newest first', async () => {
    const user = userEvent.setup();
    const search = vi.fn().mockResolvedValue({
      lines: [
        {
          time: '2026-10-25T01:00:00Z',
          message: 'GET /orders 500 password=[REDACTED]',
          agentId: 'a',
          service: 'nginx',
          level: 'error',
        },
      ],
      truncated: false,
    });
    render(<LogSearch search={search} />);
    await user.type(screen.getByLabelText('Search retained logs'), 'orders 500');
    await user.selectOptions(screen.getByLabelText('Range'), '24h');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(search).toHaveBeenCalledWith('orders 500', '24h');
    expect(await screen.findByText('GET /orders 500 password=[REDACTED]')).toBeInTheDocument();
    expect(screen.getByText('nginx')).toBeInTheDocument();
  });

  it('says when nothing matched and when retained logs are off', async () => {
    const user = userEvent.setup();
    const search = vi
      .fn()
      .mockResolvedValueOnce({ lines: [], truncated: false })
      .mockRejectedValueOnce(
        new ApiError(409, 'retained_logs_unavailable', 'Retained logs are not enabled on this platform'),
      );
    render(<LogSearch search={search} />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/No retained log lines match/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Retained logs are not enabled on this platform')).toBeInTheDocument();
  });
});

describe('RetainLogsToggle', () => {
  it('turns retained logs on for one pack', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<RetainLogsToggle name="Redis" enabled={false} onChange={onChange} />);
    await user.click(screen.getByRole('checkbox', { name: 'Keep Redis logs for 7 days (redacted)' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
