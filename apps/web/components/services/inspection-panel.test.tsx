// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InspectionPanel, type InspectionApi } from './inspection-panel';

afterEach(cleanup);

const off = { enabled: false, redisKeys: [], peekTopics: [] };

function fakeApi(over: Partial<InspectionApi> = {}): InspectionApi {
  return {
    configure: vi.fn(async (s) => ({ enabled: false, redisKeys: [], peekTopics: [], ...s })),
    request: vi.fn().mockResolvedValue({ id: 'i1', status: 'queued' }),
    get: vi.fn().mockResolvedValue({ id: 'i1', status: 'queued', result: null, error: null }),
    ...over,
  };
}

describe('InspectionPanel (WB-12 UC-12-05..08)', () => {
  it('is off by default; an owner turns it on with exact key names', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(
      <InspectionPanel name="Redis" packId="redis" settings={off} canConfigure canRun api={api} pollMs={0} />,
    );
    await user.click(screen.getByRole('button', { name: 'Data inspection' }));
    expect(screen.getByText(/Off\./)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Keys to watch (exact names, one per line)'), 'jobs\nqueue:emails');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(api.configure).toHaveBeenCalledWith({ enabled: true, redisKeys: ['jobs', 'queue:emails'] });
  });

  it('an operator cannot turn it on', async () => {
    const user = userEvent.setup();
    render(
      <InspectionPanel
        name="Redis"
        packId="redis"
        settings={off}
        canConfigure={false}
        canRun
        api={fakeApi()}
        pollMs={0}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Data inspection' }));
    expect(screen.getByText(/An owner or admin can turn it on/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
  });

  it('shows Redis counts and allowlisted key sizes, never values', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      get: vi.fn().mockResolvedValue({
        id: 'i1',
        status: 'succeeded',
        error: null,
        result: {
          info: {
            redis_version: '7.2.4',
            used_memory: '1048576',
            keyspace_hits: '90',
            keyspace_misses: '10',
          },
          dbSize: 42,
          clients: 3,
          slowlog: [{ id: 7, at: 1761300000, durationMicros: 15000, command: 'SET' }],
          latency: [],
          memory: {},
          keys: [{ key: 'jobs', type: 'list', length: 17, memoryBytes: 2048 }],
        },
      }),
    });
    render(
      <InspectionPanel
        name="Redis"
        packId="redis"
        settings={{ ...off, enabled: true, redisKeys: ['jobs'] }}
        canConfigure={false}
        canRun
        api={api}
        pollMs={0}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Data inspection' }));
    await user.click(screen.getByRole('button', { name: 'Inspect now' }));
    expect(api.request).toHaveBeenCalledWith({ packId: 'redis', target: 'redis' });
    expect(await screen.findByText('42 keys')).toBeInTheDocument();
    expect(screen.getByText('90% hit ratio')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /jobs list 17/ })).toBeInTheDocument();
    expect(screen.getByText(/SET · 15 ms/)).toBeInTheDocument();
  });

  it('TC-12-07: a Kafka peek needs a reason and shows redacted messages', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      get: vi.fn().mockResolvedValue({
        id: 'i1',
        status: 'succeeded',
        error: null,
        result: [
          { partition: 0, offset: 7, at: 1761300000000, key: '', value: '{"order":42,"email":"[redacted]"}' },
        ],
      }),
    });
    render(
      <InspectionPanel
        name="Kafka"
        packId="kafka"
        settings={{ ...off, enabled: true, peekTopics: ['orders'] }}
        canConfigure={false}
        canRun
        api={api}
        pollMs={0}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Data inspection' }));
    const peek = screen.getByRole('button', { name: 'Peek 20 latest messages' });
    expect(peek).toBeDisabled();
    await user.type(screen.getByLabelText('Reason (audited)'), 'order 42 stuck');
    await user.click(peek);
    expect(api.request).toHaveBeenCalledWith({
      packId: 'kafka',
      target: 'kafka_peek',
      topic: 'orders',
      reason: 'order 42 stuck',
    });
    expect(await screen.findByText('{"order":42,"email":"[redacted]"}')).toBeInTheDocument();
    expect(screen.getByText(/not stored/)).toBeInTheDocument();
  });
});
