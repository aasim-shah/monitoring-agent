import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertPublicDestination, createHttpClient, type LookupFn } from './index.js';

const resolvesTo =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);

const blocked = [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '0.0.0.0',
  '100.64.0.1',
  '::1',
  '::',
  'fd00::1',
  'fe80::1',
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.1',
];

describe('assertPublicDestination (BR-07-06)', () => {
  it.each(blocked)('refuses %s for central execution, as a literal and through DNS', async (ip) => {
    const literal = new URL(`http://${ip.includes(':') ? `[${ip}]` : ip}/x`);
    await expect(assertPublicDestination(literal, { allowPrivate: false })).rejects.toMatchObject({
      reason: 'destination_blocked',
    });
    await expect(
      assertPublicDestination(new URL('https://api.example.com/x'), {
        allowPrivate: false,
        lookup: resolvesTo(ip),
      }),
    ).rejects.toMatchObject({ reason: 'destination_blocked' });
  });

  it('refuses a hostname when any resolved address is private', async () => {
    await expect(
      assertPublicDestination(new URL('https://mixed.example.com'), {
        allowPrivate: false,
        lookup: resolvesTo('93.184.216.34', '10.0.0.5'),
      }),
    ).rejects.toMatchObject({ reason: 'destination_blocked' });
  });

  it('returns the vetted public address', async () => {
    await expect(
      assertPublicDestination(new URL('https://api.example.com'), {
        allowPrivate: false,
        lookup: resolvesTo('93.184.216.34'),
      }),
    ).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('refuses other schemes and credentials in the URL', async () => {
    for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'https://user:pass@example.com/']) {
      await expect(
        assertPublicDestination(new URL(u), { allowPrivate: false, lookup: resolvesTo('93.184.216.34') }),
      ).rejects.toMatchObject({ reason: 'destination_blocked' });
    }
  });

  it('private execution reaches only allowlisted private targets (TC-07-10)', async () => {
    const opts = { allowPrivate: true, allowlist: ['10.1.2.3', 'grafana.internal:3000'] };
    await expect(assertPublicDestination(new URL('http://10.1.2.3/api'), opts)).resolves.toMatchObject({
      address: '10.1.2.3',
    });
    await expect(assertPublicDestination(new URL('http://10.9.9.9/api'), opts)).rejects.toMatchObject({
      reason: 'destination_blocked',
    });
    await expect(
      assertPublicDestination(new URL('http://grafana.internal:3000/api'), {
        ...opts,
        lookup: resolvesTo('10.4.4.4'),
      }),
    ).resolves.toMatchObject({ address: '10.4.4.4' });
    await expect(
      assertPublicDestination(new URL('http://grafana.internal:4000/api'), {
        ...opts,
        lookup: resolvesTo('10.4.4.4'),
      }),
    ).rejects.toMatchObject({ reason: 'destination_blocked' });
    // Metadata endpoints stay blocked even when allowlisted.
    await expect(
      assertPublicDestination(new URL('http://169.254.169.254/'), {
        allowPrivate: true,
        allowlist: ['169.254.169.254'],
      }),
    ).rejects.toMatchObject({ reason: 'destination_blocked' });
  });
});

describe('pinned HTTP client', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        return res.end();
      }
      if (req.url === '/redirect-local') {
        res.writeHead(302, { location: '/ok' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host, path: req.url }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it('connects to the address it vetted; a second (rebinding) lookup is never made (TC-07-08)', async () => {
    const lookup = vi
      .fn<LookupFn>()
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
      .mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const client = createHttpClient({
      retries: 0,
      destination: { allowPrivate: true, allowlist: [`rebind.example.test:${port}`], lookup },
    });
    const res = await client.request(`http://rebind.example.test:${port}/ok`);
    expect(res.json()).toEqual({ host: `rebind.example.test:${port}`, path: '/ok' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('re-validates every redirect and blocks one to the metadata service (TC-07-09)', async () => {
    const client = createHttpClient({
      retries: 0,
      destination: { allowPrivate: true, allowlist: [`127.0.0.1:${port}`] },
    });
    expect((await client.request(`http://127.0.0.1:${port}/redirect-local`)).json()).toMatchObject({
      path: '/ok',
    });
    await expect(client.request(`http://127.0.0.1:${port}/redirect-metadata`)).rejects.toMatchObject({
      reason: 'destination_blocked',
    });
  });

  it('refuses a loopback target for central execution before connecting', async () => {
    const client = createHttpClient({ retries: 0, destination: { allowPrivate: false } });
    await expect(client.request(`http://127.0.0.1:${port}/ok`)).rejects.toMatchObject({
      reason: 'destination_blocked',
    });
  });
});
