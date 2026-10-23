import { describe, expect, it, vi } from 'vitest';
import { SseParser, openEventStream } from './sse';

describe('SseParser', () => {
  it('parses events split across chunks and skips comments', () => {
    const p = new SseParser();
    expect(p.push('event: ready\ndata: {"sessionId":"s"}\n\n: heartbeat\n\nevent: li')).toEqual([
      { event: 'ready', data: '{"sessionId":"s"}' },
    ]);
    expect(p.push('nes\ndata: {"lines":["a"]}\n\n')).toEqual([{ event: 'lines', data: '{"lines":["a"]}' }]);
  });
});

const streamOf = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });

describe('openEventStream', () => {
  it('delivers events, then reports the end of the stream', async () => {
    const onEvent = vi.fn();
    const done = new Promise<void>((resolve) => {
      openEventStream('/x', {
        fetch: async () => new Response(streamOf('event: lines\ndata: {"sequence":0,"lines":["hi"]}\n\n')),
        onEvent,
        onError: () => {},
        onClose: resolve,
      });
    });
    await done;
    expect(onEvent).toHaveBeenCalledWith('lines', { sequence: 0, lines: ['hi'] });
  });

  it('reports the API message of a refused stream', async () => {
    const onError = vi.fn();
    await new Promise<void>((resolve) => {
      openEventStream('/x', {
        fetch: async () =>
          new Response(
            JSON.stringify({ code: 'too_many_streams', message: 'At most 2 live tails per agent' }),
            {
              status: 429,
              headers: { 'content-type': 'application/json' },
            },
          ),
        onEvent: () => {},
        onError: (m) => {
          onError(m);
          resolve();
        },
        onClose: () => {},
      });
    });
    expect(onError).toHaveBeenCalledWith('At most 2 live tails per agent');
  });

  it('can POST a JSON body (AI questions)', async () => {
    const seen: RequestInit[] = [];
    await new Promise<void>((resolve) => {
      openEventStream('/x', {
        method: 'POST',
        body: { content: 'Why?' },
        fetch: async (_url, init) => {
          seen.push(init!);
          return new Response(streamOf('event: done\ndata: {}\n\n'));
        },
        onEvent: () => {},
        onError: () => {},
        onClose: resolve,
      });
    });
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{"content":"Why?"}' });
    expect((seen[0]!.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});
