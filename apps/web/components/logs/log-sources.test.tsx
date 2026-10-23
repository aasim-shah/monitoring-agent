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

  it('asks for an agent upgrade instead of offering sources an old agent cannot tail', () => {
    render(
      <LogSources
        sources={sources}
        canTail
        onOpen={vi.fn()}
        upgrade={{
          agentVersion: '0.1.0',
          minimumAgentVersion: '0.2.0',
          command:
            'curl -fsSL https://x/install.sh | sudo bash -s -- --control-url https://a --download-url https://x/downloads',
        }}
      />,
    );
    expect(
      screen.getByText(/Live logs need agent 0.2.0 or later; this server runs 0.1.0/),
    ).toBeInTheDocument();
    expect(screen.getByText(/install\.sh \| sudo bash/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'System journal' })).toBeNull();
  });

  it('says so when the agent has no log sources', () => {
    render(<LogSources sources={[]} canTail onOpen={vi.fn()} />);
    expect(screen.getByText(/No log sources on this agent/)).toBeInTheDocument();
  });
});
