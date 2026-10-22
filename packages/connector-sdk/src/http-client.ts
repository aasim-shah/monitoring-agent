import { ConnectorError } from './errors.js';

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

export interface HttpClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes)
    throw new ConnectorError('provider_unavailable', `response exceeds ${maxBytes} bytes`);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes)
      throw new ConnectorError('provider_unavailable', `response exceeds ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Bounded HTTP client for connectors (master plan §3): 10 s timeout, 5 MB limit,
 * 3 retries with full jitter on 429/5xx/network errors, honoring Retry-After.
 */
export function createHttpClient(opts: HttpClientOptions = {}) {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async request(url: string, init: RequestInit = {}): Promise<HttpResponse> {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
          if (attempt >= retries) {
            throw new ConnectorError(
              'provider_unavailable',
              `request failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          await sleep(Math.random() * 500 * 2 ** attempt);
          continue;
        }
        if (RETRYABLE(res.status)) {
          const wait = retryAfterMs(res.headers);
          if (attempt >= retries) {
            await res.body?.cancel();
            throw new ConnectorError(
              res.status === 429 ? 'rate_limited' : 'provider_unavailable',
              `provider returned ${res.status}`,
              {
                retryAfterSeconds: wait === undefined ? undefined : Math.ceil(wait / 1000),
              },
            );
          }
          await res.body?.cancel();
          await sleep(wait ?? Math.random() * 500 * 2 ** attempt);
          continue;
        }
        const body = await readLimited(res, maxBytes);
        return {
          status: res.status,
          headers: res.headers,
          body,
          text: () => body.toString('utf8'),
          json: <T>() => JSON.parse(body.toString('utf8')) as T,
        };
      }
    },
  };
}

export type HttpClient = ReturnType<typeof createHttpClient>;
