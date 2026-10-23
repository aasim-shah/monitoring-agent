import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SseWriter, type SseResponse } from './sse-writer.js';

function fakeResponse(destroyed = false) {
  const res = Object.assign(new EventEmitter(), {
    destroyed,
    writableEnded: false,
    headersSent: false,
    out: [] as string[],
    headers: null as Record<string, string> | null,
    writeHead(status: number, headers: Record<string, string>) {
      if (res.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
      res.headersSent = true;
      res.headers = { status: String(status), ...headers };
      return res;
    },
    write(chunk: string) {
      if (res.writableEnded) throw new Error('write after end');
      res.headersSent = true;
      res.out.push(chunk);
      return true;
    },
    end() {
      res.writableEnded = true;
      return res;
    },
  });
  return res;
}

describe('SseWriter', () => {
  it('holds events published before the stream opens, then sends them after the headers', () => {
    const res = fakeResponse();
    const w = new SseWriter(res as unknown as SseResponse);
    w.event('lines', { lines: ['early'] });
    expect(res.headersSent).toBe(false);
    w.open({ 'content-type': 'text/event-stream' }, vi.fn(), { event: 'ready', data: {} });
    expect(res.headers).toMatchObject({ status: '200', 'content-type': 'text/event-stream' });
    expect(res.out).toEqual(['event: ready\ndata: {}\n\n', 'event: lines\ndata: {"lines":["early"]}\n\n']);
  });

  it('ends after the opening when closed early, and ignores writes after closing', () => {
    const res = fakeResponse();
    const w = new SseWriter(res as unknown as SseResponse);
    w.close({ event: 'end', data: {} });
    w.event('lines', { lines: ['late'] });
    w.open({}, vi.fn());
    expect(res.out).toEqual(['event: end\ndata: {}\n\n']);
    expect(res.writableEnded).toBe(true);
    w.event('lines', { lines: ['later'] });
    w.comment('heartbeat');
    expect(res.out).toHaveLength(1);
  });

  it('reports a viewer that already left before the stream opened', () => {
    const onGone = vi.fn();
    new SseWriter(fakeResponse(true) as unknown as SseResponse).open({}, onGone);
    expect(onGone).toHaveBeenCalledOnce();
    const res = fakeResponse();
    const later = vi.fn();
    new SseWriter(res as unknown as SseResponse).open({}, later);
    expect(later).not.toHaveBeenCalled();
    res.emit('close');
    expect(later).toHaveBeenCalledOnce();
  });
});
