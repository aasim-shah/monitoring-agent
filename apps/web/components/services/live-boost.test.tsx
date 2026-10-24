// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@pcp/api-client';
import { LiveBoostControl } from './live-boost';

afterEach(cleanup);

describe('live boost control (M10.7, BR-11-08)', () => {
  it('starts a 10-minute 5 s boost', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <LiveBoostControl name="Redis" until={null} now={new Date('2026-10-25T10:00:00Z')} onStart={onStart} />,
    );
    await user.click(screen.getByRole('button', { name: 'Live (5 s) for Redis' }));
    expect(onStart).toHaveBeenCalled();
  });

  it('while active, says until when and cannot be started twice', () => {
    render(
      <LiveBoostControl
        name="Redis"
        until="2026-10-25T10:10:00Z"
        now={new Date('2026-10-25T10:03:00Z')}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Live: every 5 s, 7 min left');
    expect(screen.queryByRole('button', { name: /Live \(5 s\)/ })).toBeNull();
  });

  it('shows why a boost was refused (limit or old agent)', async () => {
    const user = userEvent.setup();
    const onStart = vi
      .fn()
      .mockRejectedValue(new ApiError(409, 'boost_limit', 'At most 3 live boosts can run at once'));
    render(<LiveBoostControl name="Redis" until={null} now={new Date()} onStart={onStart} />);
    await user.click(screen.getByRole('button', { name: 'Live (5 s) for Redis' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 3 live boosts can run at once');
  });
});
