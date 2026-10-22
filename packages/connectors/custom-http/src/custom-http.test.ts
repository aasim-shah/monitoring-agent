import type { ExecutionContext } from '@pcp/connector-sdk';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customHttpConnector, readPath } from './index.js';

let server: Server;
let base = '';
const TOKEN = 'sk_live_very_secret_token';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.headers.authorization !== `Bearer ${TOKEN}` && url.pathname !== '/public') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `bad token ${req.headers.authorization}` }));
    }
    if (url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: { users: { total: 42 }, plans: [{ mrr: 1999.5 }] } }));
    }
    if (url.pathname === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>Login</body></html>');
    }
    if (url.pathname === '/orders') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ items: [{ id: url.searchParams.get('page') }, { id: 'x' }] }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const ctx = (
  config: Record<string, unknown>,
  executionLocation: 'cloud' | 'private' = 'private',
): ExecutionContext => ({
  authenticatedOrganizationId: 'o',
  connectionId: 'c',
  executionLocation,
  requestId: 'r',
  deadline: new Date(Date.now() + 30_000).toISOString(),
  config,
  credentials: async () => ({ token: TOKEN }),
});

/** Private execution reaching the local test server through the allowlist. */
const privateConfig = (endpoints: unknown[]) => ({
  baseUrl: base,
  auth: { kind: 'bearer' },
  endpoints,
  allowPrivate: true,
  allowlist: [new URL(base).host],
});

describe('readPath', () => {
  it('reads dotted paths and array indexes', () => {
    const doc = { a: { b: [{ c: 3 }] }, 'x y': 1 };
    expect(readPath(doc, '$.a.b[0].c')).toBe(3);
    expect(readPath(doc, "$['x y']")).toBe(1);
    expect(readPath(doc, '$.a.missing')).toBeUndefined();
    expect(() => readPath(doc, 'a.b')).toThrow(/must start with \$/);
  });
});

describe('custom REST connector (WB-07 UC-07-07)', () => {
  it('extracts mapped metrics from JSON', async () => {
    const h = await customHttpConnector.health!(
      ctx(
        privateConfig([
          {
            name: 'stats',
            path: '/stats',
            metrics: [
              { name: 'users', path: '$.data.users.total' },
              { name: 'mrr', path: '$.data.plans[0].mrr', unit: 'usd' },
              { name: 'missing', path: '$.data.nope' },
            ],
          },
        ]),
      ),
    );
    expect(h.data).toEqual({
      endpoints: [
        {
          name: 'stats',
          status: 200,
          pages: 1,
          metrics: { users: 42, mrr: 1999.5, missing: null },
          warnings: ['missing: no number at $.data.nope'],
        },
      ],
    });
  });

  it('fails a non-JSON response with a sanitized diagnostic', async () => {
    await expect(
      customHttpConnector.validate(ctx(privateConfig([{ name: 'html', path: '/html', metrics: [] }]))),
    ).rejects.toMatchObject({ reason: 'invalid_response', message: expect.stringContaining('text/html') });
  });

  it('stops paginating at the configured maximum (never more than 100)', async () => {
    const h = await customHttpConnector.health!(
      ctx(
        privateConfig([
          {
            name: 'orders',
            path: '/orders',
            itemsPath: '$.items',
            pagination: { param: 'page', start: 1, max: 3 },
            metrics: [{ name: 'orders', path: '$count' }],
          },
        ]),
      ),
    );
    expect(h.data).toMatchObject({
      endpoints: [{ name: 'orders', pages: 3, metrics: { orders: 6 }, warnings: ['stopped after 3 pages'] }],
    });
    expect(
      customHttpConnector.validateConfig!(
        privateConfig([
          { name: 'o', path: '/o', metrics: [], pagination: { param: 'p', start: 1, max: 500 } },
        ]),
      ),
    ).toMatchObject({
      ok: false,
    });
  });

  it('refuses internal targets for central execution, even with an allowlist in config (TC-07-07)', async () => {
    await expect(
      customHttpConnector.validate(
        ctx(privateConfig([{ name: 'stats', path: '/stats', metrics: [] }]), 'cloud'),
      ),
    ).rejects.toMatchObject({ reason: 'destination_blocked' });
  });

  it('never puts the token in an error', async () => {
    const bad = { ...privateConfig([{ name: 'stats', path: '/stats', metrics: [] }]) };
    const run = customHttpConnector.validate({
      ...ctx(bad),
      credentials: async () => ({ token: 'sk_wrong_secret_value' }),
    });
    await expect(run).rejects.toMatchObject({ reason: 'reauthorization_required' });
    await run.catch((e: Error) => expect(e.message).not.toContain('sk_wrong_secret_value'));
  });

  it('rejects configs with paths that leave the base URL', () => {
    for (const path of ['http://evil.example/x', '//evil.example/x', 'stats']) {
      expect(
        customHttpConnector.validateConfig!(privateConfig([{ name: 'e', path, metrics: [] }])),
      ).toMatchObject({ ok: false });
    }
  });
});
