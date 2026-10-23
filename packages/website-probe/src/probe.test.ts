import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe } from './probe.js';
import { verifyDomain } from './verify.js';

let http: Server;
let https: Server;
let httpPort = 0;
let httpsPort = 0;
let ca = '';

const listen = (s: Server) =>
  new Promise<number>((r) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      r(typeof a === 'object' && a ? a.port : 0);
    }),
  );

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcp-probe-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '13',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-subj',
      '/CN=localhost/O=Probe Test CA',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  const handler: Parameters<typeof createServer>[1] = (req, res) => {
    const url = req.url ?? '/';
    if (url === '/ok') return res.end('hello');
    if (url === '/hop1') return res.writeHead(301, { location: '/hop2' }).end();
    if (url === '/hop2') return res.writeHead(302, { location: '/ok' }).end();
    if (url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    if (url === '/metadata') return res.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
    if (url === '/down') return res.writeHead(503).end('down');
    if (url === '/challenge')
      return res
        .writeHead(403, { 'cf-mitigated': 'challenge', server: 'cloudflare' })
        .end('<title>Just a moment...</title>');
    if (url === '/slow') return setTimeout(() => res.end('late'), 2000);
    res.writeHead(404).end();
  };
  http = createServer(handler);
  https = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, handler);
  [httpPort, httpsPort] = await Promise.all([listen(http), listen(https)]);
});

afterAll(async () => {
  await Promise.all([new Promise((r) => http.close(r)), new Promise((r) => https.close(r))]);
});

const destination = () => ({
  allowPrivate: true,
  allowlist: [`127.0.0.1:${httpPort}`, `localhost:${httpsPort}`],
  lookup: async () => [{ address: '127.0.0.1', family: 4 as const }],
});
const now = new Date();

describe('probe (WB-09 UC-09-03)', () => {
  it('reports status, timing, and TLS expiry and issuer', async () => {
    const r = await probe(`https://localhost:${httpsPort}/ok`, { destination: destination(), ca, now });
    expect(r).toMatchObject({
      up: true,
      statusCode: 200,
      redirects: 0,
      finalUrl: `https://localhost:${httpsPort}/ok`,
    });
    expect(r.totalMs).toBeGreaterThanOrEqual(r.ttfbMs!);
    expect(r.tls!.issuer).toBe('Probe Test CA');
    const days = (r.tls!.expiresAt.getTime() - now.getTime()) / 86400_000;
    expect(days).toBeGreaterThan(12);
    expect(days).toBeLessThan(13.1);
  });

  it('follows redirects and counts them; down for an unexpected status', async () => {
    const r = await probe(`http://127.0.0.1:${httpPort}/hop1`, { destination: destination(), now });
    expect(r).toMatchObject({
      up: true,
      statusCode: 200,
      redirects: 2,
      finalUrl: `http://127.0.0.1:${httpPort}/ok`,
    });
    expect(
      await probe(`http://127.0.0.1:${httpPort}/down`, { destination: destination(), now }),
    ).toMatchObject({
      up: false,
      statusCode: 503,
    });
    expect(
      await probe(`http://127.0.0.1:${httpPort}/ok`, {
        destination: destination(),
        now,
        expectedStatus: 201,
      }),
    ).toMatchObject({ up: false, statusCode: 200, error: 'expected HTTP 201, got 200' });
  });

  it('stops a redirect loop at 10 hops and blocks a redirect to a private address (Review Focus #3)', async () => {
    const loop = await probe(`http://127.0.0.1:${httpPort}/loop`, { destination: destination(), now });
    expect(loop).toMatchObject({ up: false, redirects: 10, error: 'redirect loop: more than 10 redirects' });
    const meta = await probe(`http://127.0.0.1:${httpPort}/metadata`, { destination: destination(), now });
    expect(meta.up).toBe(false);
    expect(meta.error).toMatch(/link-local|private/);
  });

  it('flags a Cloudflare challenge page, and times out', async () => {
    const c = await probe(`http://127.0.0.1:${httpPort}/challenge`, { destination: destination(), now });
    expect(c).toMatchObject({ up: false, statusCode: 403, challenge: true });
    const slow = await probe(`http://127.0.0.1:${httpPort}/slow`, {
      destination: destination(),
      now,
      timeoutMs: 300,
    });
    expect(slow).toMatchObject({ up: false, error: 'timed out after 300 ms' });
  });

  it('refuses a private target without an allowlist (Review Focus #1)', async () => {
    const r = await probe(`http://127.0.0.1:${httpPort}/ok`, { destination: { allowPrivate: false }, now });
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/private address/);
  });

  it('is down on a certificate it does not trust', async () => {
    const r = await probe(`https://localhost:${httpsPort}/ok`, { destination: destination(), now });
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/certificate/i);
  });
});

describe('verifyDomain (UC-09-01, Review Focus #2)', () => {
  const records: Record<string, string[][]> = {
    'example.com': [['pcp-verify=tok-123']],
    'other.org': [['pcp-verify=someone-else']],
    com: [['pcp-verify=tok-123']],
    'co.uk': [['pcp-verify=tok-123']],
  };
  const resolveTxt = async (name: string) => {
    const r = records[name];
    if (!r) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    return r;
  };

  it('finds the token on the host or a parent domain', async () => {
    expect(await verifyDomain('shop.example.com', 'tok-123', resolveTxt)).toEqual({
      verified: true,
      checkedNames: ['shop.example.com', 'example.com'],
    });
  });

  it('never accepts a public suffix, a wrong token, or a single label', async () => {
    expect((await verifyDomain('shop.other.com', 'tok-123', resolveTxt)).verified).toBe(false);
    expect((await verifyDomain('shop.other.com', 'tok-123', resolveTxt)).checkedNames).toEqual([
      'shop.other.com',
      'other.com',
    ]);
    expect((await verifyDomain('x.co.uk', 'tok-123', resolveTxt)).checkedNames).toEqual(['x.co.uk']);
    expect((await verifyDomain('other.org', 'tok-123', resolveTxt)).verified).toBe(false);
    expect((await verifyDomain('localhost', 'tok-123', resolveTxt)).checkedNames).toEqual([]);
  });
});
