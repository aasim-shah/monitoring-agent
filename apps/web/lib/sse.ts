/** Incremental `text/event-stream` parser: feed it decoded text, get complete events back. */
export class SseParser {
  private buffer = '';

  push(text: string): Array<{ event: string; data: string }> {
    this.buffer += text.replace(/\r\n/g, '\n');
    const events: Array<{ event: string; data: string }> = [];
    let cut: number;
    while ((cut = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) events.push({ event, data: data.join('\n') });
    }
    return events;
  }
}

export interface EventStreamHandlers {
  onEvent(event: string, data: unknown): void;
  /** The stream was refused or broke; `message` is the API's reason when it gave one. */
  onError(message: string): void;
  onClose(): void;
  fetch?: typeof fetch;
  /** POST with a JSON body (the AI assistant); GET by default. */
  method?: 'GET' | 'POST';
  body?: unknown;
}

/**
 * Opens a same-origin event stream with `fetch` rather than `EventSource`: a refused stream
 * (400, 429) shows the API's reason, and nothing reconnects on its own and opens a new
 * stream. Returns a function that closes it.
 */
export function openEventStream(url: string, handlers: EventStreamHandlers): () => void {
  const ctrl = new AbortController();
  const doFetch = handlers.fetch ?? fetch;
  void (async () => {
    try {
      const res = await doFetch(url, {
        method: handlers.method ?? 'GET',
        headers: {
          accept: 'text/event-stream',
          ...(handlers.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(handlers.body === undefined ? {} : { body: JSON.stringify(handlers.body) }),
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        handlers.onError(body?.message ?? `The log stream was refused (${res.status}).`);
        return;
      }
      const parser = new SseParser();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const e of parser.push(value)) {
          let data: unknown = e.data;
          try {
            data = JSON.parse(e.data);
          } catch {
            // plain text data
          }
          handlers.onEvent(e.event, data);
        }
      }
      handlers.onClose();
    } catch {
      if (!ctrl.signal.aborted) handlers.onError('The connection to the log stream was lost.');
    }
  })();
  return () => ctrl.abort();
}
