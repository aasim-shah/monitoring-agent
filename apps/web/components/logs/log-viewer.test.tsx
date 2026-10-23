// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogViewer, MAX_LINES, type TailHandlers } from './log-viewer';

afterEach(cleanup);

function fakeTail() {
  let h: TailHandlers | null = null;
  const disconnect = vi.fn();
  const connect = vi.fn((handlers: TailHandlers) => {
    h = handlers;
    return disconnect;
  });
  return {
    connect,
    disconnect,
    emit: (event: string, data: unknown) => act(() => h!.onEvent(event, data)),
    fail: (message: string) => act(() => h!.onError(message)),
  };
}

const source = { id: 'redis.server', label: 'Redis server log' };

describe('LogViewer (WB-12 UC-12-01)', () => {
  it('appends lines, keeps the last 2,000, and says nothing is stored', () => {
    const tail = fakeTail();
    render(<LogViewer source={source} connect={tail.connect} onClose={vi.fn()} />);
    expect(screen.getByText(/Masked on the server before sending; nothing is stored/)).toBeInTheDocument();
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    tail.emit('ready', { sessionId: 's1', source: 'redis.server' });
    expect(screen.getByText('Waiting for new lines…')).toBeInTheDocument();
    tail.emit('lines', { sequence: 0, lines: ['first', 'password=[REDACTED]'] });
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('password=[REDACTED]')).toBeInTheDocument();
    tail.emit('lines', {
      sequence: 1,
      lines: Array.from({ length: MAX_LINES + 5 }, (_, i) => `line ${i}`),
    });
    const log = screen.getByRole('log');
    expect(log.querySelectorAll('li')).toHaveLength(MAX_LINES);
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.getByText(`line ${MAX_LINES + 4}`)).toBeInTheDocument();
  });

  it('marks dropped-line notices', () => {
    const tail = fakeTail();
    render(<LogViewer source={source} connect={tail.connect} onClose={vi.fn()} />);
    tail.emit('lines', { sequence: 0, lines: ['[pcp] dropped 812 lines (rate limit 200/s)'] });
    expect(screen.getByText(/dropped 812 lines/).closest('li')).toHaveAttribute('data-kind', 'notice');
  });

  it('buffers while paused and flushes on resume; Clear empties the view', async () => {
    const user = userEvent.setup();
    const tail = fakeTail();
    render(<LogViewer source={source} connect={tail.connect} onClose={vi.fn()} />);
    tail.emit('lines', { sequence: 0, lines: ['before'] });
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    tail.emit('lines', { sequence: 1, lines: ['during 1', 'during 2'] });
    expect(screen.queryByText('during 1')).toBeNull();
    expect(screen.getByText('2 new lines')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByText('during 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('log').querySelectorAll('li')).toHaveLength(0);
  });

  it('shows the end of the stream and errors with their reason', () => {
    const tail = fakeTail();
    const { unmount } = render(<LogViewer source={source} connect={tail.connect} onClose={vi.fn()} />);
    tail.emit('end', {});
    expect(screen.getByText('Stream ended')).toBeInTheDocument();
    unmount();
    const t2 = fakeTail();
    render(<LogViewer source={source} connect={t2.connect} onClose={vi.fn()} />);
    t2.fail('At most 2 live tails per agent');
    expect(screen.getByRole('alert')).toHaveTextContent('At most 2 live tails per agent');
  });

  it('disconnects when closed or unmounted', async () => {
    const user = userEvent.setup();
    const tail = fakeTail();
    const onClose = vi.fn();
    const { unmount } = render(<LogViewer source={source} connect={tail.connect} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close logs' }));
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(tail.disconnect).toHaveBeenCalled();
  });
});
