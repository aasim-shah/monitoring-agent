import { Agent, fetch as undiciFetch } from 'undici';
import { ConnectorError } from './errors.js';
import { assertPublicDestination, type DestinationOptions } from './ssrf-guard.js';

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
  /**
   * SSRF protection (BR-07-06): each request (and each redirect, at most 3) is resolved
   * once, checked, and sent to that address only. Required for user-supplied URLs.
   */
  destination?: DestinationOptions;
}

const MAX_REDIRECTS = 3;

/** A dispatcher whose DNS lookup always answers with the vetted address. */
function pinnedAgent(address: string, family: 4 | 6, timeoutMs: number) {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup: (_hostname, options, callback) => {
        if ((options as { all?: boolean }).all) callback(null, [{ address, family }]);
        else (callback as (e: null, a: string, f: number) => void)(null, address, family);
      },
    },
  });
}

/** Fetch with SSRF checks on the URL and every redirect. */
async function guardedFetch(
  url: string,
  init: RequestInit,
  destination: DestinationOptions,
  timeoutMs: number,
): Promise<Response> {
  let target = new URL(url);
  for (let hop = 0; ; hop++) {
    const { address, family } = await assertPublicDestination(target, destination);
    const dispatcher = pinnedAgent(address, family, timeoutMs);
    try {
      const res = (await undiciFetch(target, {
        ...(init as object),
        redirect: 'manual',
        dispatcher,
      })) as unknown as Response;
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw new ConnectorError('provider_unavailable', 'too many redirects');
        target = new URL(location, target);
        continue;
      }
      return res;
    } finally {
      // Keep the connection open until the body is read; close idle sockets afterwards.
      void dispatcher.close().catch(() => {});
    }
  }
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
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const doFetch: (url: string, init: RequestInit) => Promise<Response> = opts.destination
    ? (url, init) => guardedFetch(url, init, opts.destination!, timeoutMs)
    : (opts.fetch ?? fetch);
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
          if (err instanceof ConnectorError) throw err;
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
