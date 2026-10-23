import { connect as tlsConnect } from 'node:tls';
import { assertPublicDestination, type DestinationOptions } from '@pcp/connector-sdk';
import { Agent, request } from 'undici';

export interface ProbeOptions {
  destination: DestinationOptions;
  now: Date;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Null: any 2xx or 3xx after redirects counts as up. */
  expectedStatus?: number | null;
  /** Extra trusted CA (tests only). */
  ca?: string;
}

export interface ProbeResult {
  up: boolean;
  statusCode: number | null;
  finalUrl: string;
  redirects: number;
  totalMs: number;
  ttfbMs: number | null;
  tls: { expiresAt: Date; issuer: string } | null;
  error?: string;
  /** A Cloudflare (or similar) challenge page answered instead of the site. */
  challenge?: boolean;
}

const MAX_BODY = 64 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function pinned(address: string, family: 4 | 6, timeoutMs: number, ca?: string) {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      ...(ca ? { ca } : {}),
      lookup: (_host, options, callback) => {
        if ((options as { all?: boolean }).all) callback(null, [{ address, family }]);
        else (callback as (e: null, a: string, f: number) => void)(null, address, family);
      },
    },
  });
}

/** Certificate expiry and issuer through the vetted address (read even when the HTTP request fails). */
function readCertificate(url: URL, address: string, timeoutMs: number) {
  return new Promise<{ expiresAt: Date; issuer: string } | null>((resolve) => {
    const socket = tlsConnect({
      host: address,
      port: Number(url.port || 443),
      servername: url.hostname,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    const done = (v: { expiresAt: Date; issuer: string } | null) => {
      socket.destroy();
      resolve(v);
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert?.valid_to) return done(null);
      const issuer = cert.issuer as Record<string, string | string[]> | undefined;
      const name = issuer?.O ?? issuer?.CN ?? '';
      done({ expiresAt: new Date(cert.valid_to), issuer: Array.isArray(name) ? name.join(', ') : name });
    });
    socket.once('error', () => done(null));
    socket.once('timeout', () => done(null));
  });
}

/**
 * One probe (WB-09 UC-09-03): every hop is resolved once, checked against the SSRF policy, and
 * sent to that address only; at most 10 redirects; body read capped at 64 KB.
 */
export async function probe(rawUrl: string, opts: ProbeOptions): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRedirects = opts.maxRedirects ?? 10;
  const started = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  let url = new URL(rawUrl);
  let redirects = 0;
  let tls: ProbeResult['tls'] = null;
  const result = (r: Partial<ProbeResult>): ProbeResult => ({
    up: false,
    statusCode: null,
    finalUrl: url.toString(),
    redirects,
    totalMs: Math.round(performance.now() - started),
    ttfbMs: null,
    tls,
    ...r,
  });
  try {
    for (;;) {
      const { address, family } = await assertPublicDestination(url, opts.destination);
      if (url.protocol === 'https:' && !tls) tls = await readCertificate(url, address, timeoutMs);
      const dispatcher = pinned(address, family, timeoutMs, opts.ca);
      try {
        const res = await request(url, {
          method: 'GET',
          dispatcher,
          signal: deadline,
          headers: { 'user-agent': 'ProductControlPlane-Probe/1 (+uptime monitor)' },
        });
        const ttfbMs = Math.round(performance.now() - started);
        const location = res.headers.location;
        if (REDIRECTS.has(res.statusCode) && typeof location === 'string') {
          await res.body.dump();
          if (redirects >= maxRedirects)
            return result({
              statusCode: res.statusCode,
              error: `redirect loop: more than ${maxRedirects} redirects`,
            });
          redirects++;
          url = new URL(location, url);
          continue;
        }
        let body = '';
        for await (const chunk of res.body) {
          body += Buffer.from(chunk as Uint8Array).toString('utf8');
          if (body.length >= MAX_BODY) break;
        }
        await res.body.dump().catch(() => {});
        const challenge =
          res.headers['cf-mitigated'] === 'challenge' ||
          ((res.statusCode === 403 || res.statusCode === 503) &&
            /challenge-platform|<title>Just a moment/i.test(body));
        const expectedOk = opts.expectedStatus
          ? res.statusCode === opts.expectedStatus
          : res.statusCode >= 200 && res.statusCode < 400;
        return result({
          up: expectedOk && !challenge,
          statusCode: res.statusCode,
          ttfbMs,
          ...(challenge
            ? { challenge: true, error: 'a challenge page answered; allowlist the probe user agent' }
            : {}),
          ...(!expectedOk && opts.expectedStatus
            ? { error: `expected HTTP ${opts.expectedStatus}, got ${res.statusCode}` }
            : {}),
        });
      } finally {
        void dispatcher.close().catch(() => {});
      }
    }
  } catch (err) {
    if (deadline.aborted) return result({ error: `timed out after ${timeoutMs} ms` });
    const e = err as Error & { cause?: Error; code?: string };
    return result({ error: (e.cause?.message ?? e.message ?? String(err)).slice(0, 300) });
  }
}
