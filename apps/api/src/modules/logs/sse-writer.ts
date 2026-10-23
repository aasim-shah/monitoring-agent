import type { ServerResponse } from 'node:http';

export type SseResponse = Pick<
  ServerResponse,
  'writeHead' | 'write' | 'end' | 'on' | 'destroyed' | 'writableEnded'
>;

/**
 * Writes server-sent events to a raw response. Events produced before `open` (an agent that
 * answers while the task is still being created) wait for the headers; nothing is written
 * after `close`.
 */
export class SseWriter {
  private opened = false;
  private closed = false;
  private readonly queue: string[] = [];

  constructor(private readonly res: SseResponse) {}

  /**
   * Sends the headers, `first`, then anything queued; `onGone` runs when the viewer
   * disconnects.
   */
  open(headers: Record<string, string>, onGone: () => void, first?: { event: string; data: unknown }): void {
    this.res.writeHead(200, headers);
    this.opened = true;
    if (first) this.res.write(`event: ${first.event}\ndata: ${JSON.stringify(first.data)}\n\n`);
    for (const chunk of this.queue.splice(0)) this.res.write(chunk);
    if (this.closed) {
      this.res.end();
      return;
    }
    this.res.on('close', onGone);
    // The viewer may have left while the task was being created.
    if (this.res.destroyed) onGone();
  }

  event(event: string, data: unknown): void {
    this.send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  comment(text: string): void {
    this.send(`: ${text}\n\n`);
  }

  close(last?: { event: string; data: unknown }): void {
    if (this.closed) return;
    if (last) this.event(last.event, last.data);
    this.closed = true;
    if (this.opened && !this.res.writableEnded) this.res.end();
  }

  private send(chunk: string): void {
    if (this.closed) return;
    if (!this.opened) this.queue.push(chunk);
    else if (!this.res.writableEnded) this.res.write(chunk);
  }
}
