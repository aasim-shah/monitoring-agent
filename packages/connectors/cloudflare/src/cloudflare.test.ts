import type { ExecutionContext } from '@pcp/connector-sdk';
import { describe, expect, it } from 'vitest';
import { createCloudflareConnector } from './index.js';

const ZONE = '023e105f4ecef8ad9ca31a8372d0c353';

const ctx = (creds: Record<string, string> = { apiToken: 'cf-token' }): ExecutionContext => ({
  authenticatedOrganizationId: 'org',
  connectionId: 'conn-1',
  executionLocation: 'cloud',
  requestId: 'r',
  deadline: new Date(Date.now() + 30_000).toISOString(),
  config: {},
  credentials: async () => creds,
});

type Route = (url: URL, init: RequestInit) => { status: number; body: unknown } | undefined;

/** Recorded Cloudflare API answers (shapes from the v4 API docs). */
function fakeFetch(routes: Route[]) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`);
    for (const r of routes) {
      const hit = r(url, init);
      if (hit)
        return new Response(JSON.stringify(hit.body), {
          status: hit.status,
          headers: { 'content-type': 'application/json' },
        });
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }), {
      status: 404,
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = (result: unknown, info?: unknown) => ({
  success: true,
  errors: [],
  result,
  ...(info ? { result_info: info } : {}),
});
const verify: Route = (u) =>
  u.pathname.endsWith('/user/tokens/verify')
    ? { status: 200, body: ok({ id: 't', status: 'active' }) }
    : undefined;
const zones: Route = (u) =>
  u.pathname.endsWith('/zones')
    ? {
        status: 200,
        body: ok(
          [
            {
              id: ZONE,
              name: 'firemaps.example',
              status: 'active',
              plan: { name: 'Free Website' },
              name_servers: ['a.ns.cloudflare.com'],
              account: { id: 'acc', name: 'Acme' },
            },
          ],
          { page: 1, total_pages: 1 },
        ),
      }
    : undefined;
const records =
  (status = 200): Route =>
  (u) =>
    u.pathname.endsWith(`/zones/${ZONE}/dns_records`)
      ? status === 200
        ? {
            status: 200,
            body: ok(
              [
                {
                  id: 'r1',
                  type: 'A',
                  name: 'firemaps.example',
                  content: '203.0.113.10',
                  proxied: true,
                  ttl: 1,
                },
                {
                  id: 'r2',
                  type: 'CNAME',
                  name: 'www.firemaps.example',
                  content: 'firemaps.example',
                  proxied: true,
                  ttl: 1,
                },
                {
                  id: 'r3',
                  type: 'A',
                  name: 'api.firemaps.example',
                  content: '203.0.113.11',
                  proxied: false,
                  ttl: 300,
                },
              ],
              { page: 1, total_pages: 1 },
            ),
          }
        : {
            status,
            body: {
              success: false,
              errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
            },
          }
      : undefined;
const certs: Route = (u) =>
  u.pathname.endsWith(`/zones/${ZONE}/ssl/certificate_packs`)
    ? {
        status: 200,
        body: ok([
          {
            id: 'c1',
            status: 'active',
            hosts: ['firemaps.example', '*.firemaps.example'],
            certificates: [{ expires_on: '2027-01-01T00:00:00Z' }],
          },
        ]),
      }
    : undefined;

describe('Cloudflare connector (WB-06 UC-06-01/02)', () => {
  it('TC-06-01: an active token with zone and DNS read validates', async () => {
    const { fetch } = fakeFetch([verify, zones, records()]);
    const c = createCloudflareConnector({ fetch });
    expect(await c.validate(ctx())).toEqual({ ok: true, accountId: 'acc' });
  });

  it('TC-06-01: a token without DNS read is permission_denied, naming the permission', async () => {
    const { fetch } = fakeFetch([verify, zones, records(403)]);
    expect(await createCloudflareConnector({ fetch }).validate(ctx())).toEqual({
      ok: false,
      accountId: 'acc',
      missingPermissions: ['Zone: DNS: Read'],
    });
  });

  it('an inactive or rejected token needs reauthorization', async () => {
    const { fetch } = fakeFetch([
      (u) =>
        u.pathname.endsWith('/verify')
          ? { status: 401, body: { success: false, errors: [{ message: 'Invalid API Token' }] } }
          : undefined,
    ]);
    await expect(createCloudflareConnector({ fetch }).validate(ctx())).rejects.toMatchObject({
      reason: 'reauthorization_required',
    });
  });

  it('TC-06-02: discovers zones, each DNS record, and certificates', async () => {
    const { fetch } = fakeFetch([verify, zones, records(), certs]);
    const page = await createCloudflareConnector({ fetch }).discover!(ctx());
    const byType = (t: string) => page.observations.filter((o) => o.resourceType === t);
    expect(byType('cloudflare_zone')).toEqual([
      expect.objectContaining({
        externalId: ZONE,
        attributes: expect.objectContaining({
          name: 'firemaps.example',
          status: 'active',
          plan: 'Free Website',
        }),
      }),
    ]);
    expect(byType('dns_record')).toHaveLength(3);
    expect(byType('dns_record')[0]).toMatchObject({
      externalId: 'r1',
      attributes: {
        zoneId: ZONE,
        zone: 'firemaps.example',
        type: 'A',
        name: 'firemaps.example',
        content: '203.0.113.10',
        proxied: true,
      },
    });
    expect(byType('certificate_pack')[0]).toMatchObject({
      attributes: { status: 'active', expiresOn: '2027-01-01T00:00:00Z' },
    });
  });

  it('keeps discovering zones when DNS or certificates are not readable (Review Focus #2)', async () => {
    const { fetch } = fakeFetch([verify, zones, records(403)]);
    const page = await createCloudflareConnector({ fetch }).discover!(ctx());
    expect(page.observations.map((o) => o.resourceType)).toEqual(['cloudflare_zone']);
  });

  it('verifies notifications with the shared secret and records DNS and security events', async () => {
    const c = createCloudflareConnector({});
    const body = Buffer.from(
      JSON.stringify({
        name: 'dns',
        text: 'DNS record changed: api.firemaps.example',
        alert_type: 'dns_records_changed',
        ts: 1792800000,
      }),
    );
    const req = {
      headers: { 'cf-webhook-auth': 'shh' },
      rawBody: body,
      payload: JSON.parse(body.toString()),
    };
    expect(c.verifyWebhook!(req, { apiToken: 't', webhookSecret: 'shh' })).toMatchObject({
      ok: true,
      eventType: 'dns_records_changed',
    });
    expect(
      c.verifyWebhook!(
        { ...req, headers: { 'cf-webhook-auth': 'nope' } },
        { apiToken: 't', webhookSecret: 'shh' },
      ),
    ).toEqual({ ok: false });
    const [o] = await c.ingestEvent!(ctx(), {
      eventType: 'dns_records_changed',
      headers: {},
      payload: req.payload,
    });
    expect(o).toMatchObject({
      resourceType: 'change_event',
      attributes: {
        kind: 'dns_change',
        title: 'DNS record changed: api.firemaps.example',
        occurredAt: '2026-10-24T00:00:00.000Z',
      },
    });
  });

  it('purges cache URLs and reports a refused purge (M16 UC-16-06)', async () => {
    const purge =
      (status: number): Route =>
      (u) =>
        u.pathname.endsWith(`/zones/${ZONE}/purge_cache`)
          ? status === 200
            ? { status: 200, body: ok({ id: 'p-1' }) }
            : { status, body: { success: false, errors: [{ message: 'Authentication error' }] } }
          : undefined;
    const done = await createCloudflareConnector({ fetch: fakeFetch([purge(200)]).fetch }).executeAction!(
      ctx(),
      {
        kind: 'purge_cache',
        zoneId: ZONE,
        urls: ['https://firemaps.example/app.css'],
      },
    );
    expect(done).toEqual({ ok: true, result: { purgeId: 'p-1' }, verification: { apiSuccess: true } });
    const refused = await createCloudflareConnector({ fetch: fakeFetch([purge(403)]).fetch }).executeAction!(
      ctx(),
      {
        kind: 'purge_cache',
        zoneId: ZONE,
        everything: true,
      },
    );
    expect(refused).toEqual({ ok: false, error: 'Cloudflare answered 403: Authentication error' });
  });
});
