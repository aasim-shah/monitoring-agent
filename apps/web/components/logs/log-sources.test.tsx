// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogSources } from './log-sources';

afterEach(cleanup);

const sources = [
  { id: 'redis.server', label: 'Redis server log' },
  { id: 'host.journal', label: 'System journal' },
];

describe('LogSources', () => {
  it('lists the sources the API allows and opens one', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<LogSources sources={sources} canTail onOpen={onOpen} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Redis server log',
      'System journal',
    ]);
    await user.click(screen.getByRole('button', { name: 'System journal' }));
    expect(onOpen).toHaveBeenCalledWith(sources[1]);
  });

  it('renders nothing without logs.tail', () => {
    const { container } = render(<LogSources sources={sources} canTail={false} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
