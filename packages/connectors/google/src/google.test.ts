import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { ExecutionContext } from '@pcp/connector-sdk';
import { describe, expect, it } from 'vitest';
import {
  createGoogleConnector,
  serviceStatus,
  missingScopes,
  GOOGLE_DATA_SCOPES,
  SCOPE_PREFIX,
  SERVICE_ACCOUNT_SCOPES,
  parseServiceAccountKey,
} from './index.js';

const ALL = GOOGLE_DATA_SCOPES;
const NOW = new Date('2026-10-25T10:00:00Z');

const ctx = (granted: string[] = ALL, refreshToken = 'rt-1'): ExecutionContext => ({
  authenticatedOrganizationId: 'org',
  connectionId: 'conn-1',
  executionLocation: 'cloud',
  requestId: 'r',
  deadline: new Date(Date.now() + 30_000).toISOString(),
  config: {},
  credentials: async () => ({ refreshToken }),
  grantedScopes: granted,
});

type Answer = { status: number; body: unknown } | undefined;
interface Call {
  method: string;
  url: URL;
  body: string;
  auth: string;
}

/** A fake Google: OAuth token endpoint plus the read APIs the connector calls. */
function fakeGoogle(override: (c: Call) => Answer = () => undefined) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? ''),
      auth: new Headers(init?.headers).get('authorization') ?? '',
    };
    calls.push(call);
    const a = override(call) ?? standard(call) ?? { status: 404, body: { error: { message: 'Not found' } } };
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function standard({ method, url, body }: Call): Answer {
  const p = `${url.hostname}${url.pathname}`;
  if (p === 'oauth2.googleapis.com/token') {
    const form = new URLSearchParams(body);
    return form.get('refresh_token') === 'revoked'
      ? {
          status: 400,
          body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        }
      : { status: 200, body: { access_token: 'at-1', expires_in: 3599, token_type: 'Bearer' } };
  }
  if (p === 'analyticsadmin.googleapis.com/v1beta/accountSummaries')
    return {
      status: 200,
      body: {
        accountSummaries: [
          {
            account: 'accounts/9',
            displayName: 'Acme',
            propertySummaries: [{ property: 'properties/123', displayName: 'Shop web' }],
          },
        ],
      },
    };
  if (p === 'analyticsadmin.googleapis.com/v1beta/properties/123')
    return { status: 200, body: { name: 'properties/123', timeZone: 'Asia/Karachi', currencyCode: 'PKR' } };
  if (p === 'analyticsadmin.googleapis.com/v1beta/properties/123/dataStreams')
    return {
      status: 200,
      body: {
        dataStreams: [
          {
            type: 'WEB_DATA_STREAM',
            displayName: 'web',
            webStreamData: { defaultUri: 'https://shop.example' },
          },
          {
            type: 'ANDROID_APP_DATA_STREAM',
            displayName: 'app',
            androidAppStreamData: { packageName: 'com.acme.shop' },
          },
        ],
      },
    };
  if (method === 'POST' && p === 'analyticsdata.googleapis.com/v1beta/properties/123:runReport') {
    const req = JSON.parse(body) as { dimensions: Array<{ name: string }> };
    const pair = (a: string, b: string, v: string) => ({
      dimensionValues: [{ value: a }, { value: b }],
      metricValues: [{ value: v }],
    });
    if (req.dimensions[1]?.name === 'hour')
      return { status: 200, body: { rows: [pair('20261024', '22', '61'), pair('20261024', '03', '2')] } };
    if (req.dimensions[1]?.name === 'eventName')
      return {
        status: 200,
        body: { rows: [pair('20261024', 'sign_up', '34'), pair('20261024', 'page_view', '900')] },
      };
    if (req.dimensions.length === 2)
      return {
        status: 200,
        body: {
          rows: [
            {
              dimensionValues: [{ value: '20261025' }, { value: 'Organic Search' }],
              metricValues: [{ value: '30' }],
            },
          ],
        },
      };
    const row = (d: string, n: number) => ({
      dimensionValues: [{ value: d }],
      metricValues: [n, n - 2, n + 5, n * 3, 0.61, 4].map((v) => ({ value: String(v) })),
    });
    return { status: 200, body: { rows: [row('20261024', 100), row('20261025', 40)], propertyQuota: {} } };
  }
  if (p === 'www.googleapis.com/webmasters/v3/sites')
    return {
      status: 200,
      body: { siteEntry: [{ siteUrl: 'sc-domain:shop.example', permissionLevel: 'siteOwner' }] },
    };
  if (
    method === 'POST' &&
    p === 'www.googleapis.com/webmasters/v3/sites/sc-domain%3Ashop.example/searchAnalytics/query'
  )
    return {
      status: 200,
      body: {
        rows: [
          { keys: ['2026-10-20'], clicks: 12, impressions: 300, ctr: 0.04, position: 8.2 },
          { keys: ['2026-10-23'], clicks: 3, impressions: 90, ctr: 0.033, position: 9.1 },
        ],
      },
    };
  if (p === 'firebase.googleapis.com/v1beta1/projects')
    return { status: 200, body: { results: [{ projectId: 'acme-shop', displayName: 'Acme Shop' }] } };
  if (p === 'firebase.googleapis.com/v1beta1/projects/acme-shop/androidApps')
    return {
      status: 200,
      body: { apps: [{ appId: '1:1:android:a', displayName: 'Shop', packageName: 'com.acme.shop' }] },
    };
  if (p === 'firebase.googleapis.com/v1beta1/projects/acme-shop/iosApps')
    return {
      status: 200,
      body: { apps: [{ appId: '1:1:ios:b', displayName: 'Shop iOS', bundleId: 'com.acme.shop.ios' }] },
    };
  if (p === 'playdeveloperreporting.googleapis.com/v1beta1/apps:search')
    return {
      status: 200,
      body: { apps: [{ name: 'apps/com.acme.shop', packageName: 'com.acme.shop', displayName: 'Shop' }] },
    };
  const set =
    /^playdeveloperreporting\.googleapis\.com\/v1beta1\/apps\/com\.acme\.shop\/(crashRate|anrRate)MetricSet(:query)?$/.exec(
      p,
    );
  if (set && !set[2])
    return {
      status: 200,
      body: {
        freshnessInfo: {
          freshnesses: [
            {
              aggregationPeriod: 'DAILY',
              latestEndTime: { year: 2026, month: 10, day: 24, timeZone: { id: 'America/Los_Angeles' } },
            },
          ],
        },
      },
    };
  if (set && set[2]) {
    const metrics =
      set[1] === 'crashRate'
        ? [
            { metric: 'crashRate', decimalValue: { value: '0.0123' } },
            { metric: 'userPerceivedCrashRate', decimalValue: { value: '0.0101' } },
            { metric: 'distinctUsers', decimalValue: { value: '850' } },
          ]
        : [
            { metric: 'anrRate', decimalValue: { value: '0.004' } },
            { metric: 'userPerceivedAnrRate', decimalValue: { value: '0.003' } },
          ];
    return { status: 200, body: { rows: [{ startTime: { year: 2026, month: 10, day: 23 }, metrics }] } };
  }
  return undefined;
}

const connector = (fake = fakeGoogle()) =>
  createGoogleConnector({
    clientId: 'cid',
    clientSecret: 'csecret',
    fetch: fake.fetch,
    now: () => NOW,
    sleep: async () => {},
  });

describe('Google scopes (WB-08 UC-08-01/02, BR-08-03)', () => {
  it('derives each service status from the granted scopes; Ads waits for platform approval', () => {
    const partial = ALL.filter((s) => !s.endsWith('adwords') && !s.endsWith('bigquery.readonly'));
    expect(serviceStatus(partial)).toEqual({
      ga4: 'available',
      searchConsole: 'available',
      firebase: 'available',
      play: 'available',
      ads: 'permission_denied',
      bigquery: 'permission_denied',
    });
    expect(serviceStatus(ALL).ads).toBe('pending_platform_approval');
    expect(missingScopes(partial)).toEqual([`${SCOPE_PREFIX}adwords`, `${SCOPE_PREFIX}bigquery.readonly`]);
  });
});

describe('Google connector (WB-08 UC-08-04/05/07/08)', () => {
  it('refreshes the access token with the client credentials and validates the granted services', async () => {
    const fake = fakeGoogle();
    const out = await connector(fake).validate(ctx());
    expect(out).toEqual({ ok: true });
    const token = fake.calls.find((c) => c.url.hostname === 'oauth2.googleapis.com')!;
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({
      client_id: 'cid',
      client_secret: 'csecret',
      refresh_token: 'rt-1',
      grant_type: 'refresh_token',
    });
    expect(
      fake.calls
        .filter((c) => c.url.hostname !== 'oauth2.googleapis.com')
        .every((c) => c.auth === 'Bearer at-1'),
    ).toBe(true);
  });

  it('a revoked refresh token (invalid_grant) is reauthorization_required', async () => {
    await expect(connector().validate(ctx(ALL, 'revoked'))).rejects.toMatchObject({
      reason: 'reauthorization_required',
    });
  });

  it('reads only granted services: an ungranted service is never called; a 403 is named', async () => {
    const onlyGa4 = [`${SCOPE_PREFIX}analytics.readonly`, `${SCOPE_PREFIX}webmasters.readonly`];
    const fake = fakeGoogle((c) =>
      c.url.hostname === 'www.googleapis.com'
        ? {
            status: 403,
            body: {
              error: { status: 'PERMISSION_DENIED', message: 'User does not have sufficient permission' },
            },
          }
        : undefined,
    );
    expect(await connector(fake).validate(ctx(onlyGa4))).toEqual({
      ok: true,
      missingPermissions: ['Search Console: User does not have sufficient permission'],
    });
    expect(
      fake.calls.some((c) => c.url.hostname.startsWith('firebase') || c.url.hostname.startsWith('playdev')),
    ).toBe(false);
  });

  it('discovers GA4 properties with streams, Search Console sites, Firebase apps, and Play apps', async () => {
    const { observations } = await connector().discover!(ctx());
    const byType = (t: string) => observations.filter((o) => o.resourceType === t);
    expect(byType('google_ga4_property').map((o) => [o.externalId, o.attributes])).toEqual([
      [
        'properties/123',
        {
          name: 'Shop web',
          account: 'Acme',
          timeZone: 'Asia/Karachi',
          currencyCode: 'PKR',
          streams: [
            { type: 'web', name: 'web', url: 'https://shop.example' },
            { type: 'android', name: 'app', packageName: 'com.acme.shop' },
          ],
        },
      ],
    ]);
    expect(byType('google_search_console_site').map((o) => o.externalId)).toEqual(['sc-domain:shop.example']);
    expect(byType('google_firebase_project').map((o) => o.externalId)).toEqual(['acme-shop']);
    expect(byType('google_firebase_app').map((o) => [o.externalId, o.attributes.platform])).toEqual([
      ['1:1:android:a', 'android'],
      ['1:1:ios:b', 'ios'],
    ]);
    expect(byType('google_play_app').map((o) => o.externalId)).toEqual(['com.acme.shop']);
  });

  it('syncs GA4 daily values in the property timezone; today is partial', async () => {
    const fake = fakeGoogle();
    const { points } = await connector(fake).sync!(ctx(), {
      scopes: [{ resourceType: 'google_ga4_property', externalId: 'properties/123' }],
      days: 3,
    });
    const report = fake.calls.find((c) => c.url.pathname.endsWith(':runReport'))!;
    expect(JSON.parse(report.body)).toMatchObject({
      dateRanges: [{ startDate: '2026-10-23', endDate: '2026-10-25' }],
      returnPropertyQuota: true,
    });
    const v = (metric: string, day: string, dimension?: string) =>
      points.find((p) => p.metric === metric && p.day === day && p.dimension === dimension);
    expect(v('activeUsers', '2026-10-24')).toMatchObject({ value: 100, completeness: 'complete' });
    // 15:00 in Karachi on 2026-10-25: today is still being processed.
    expect(v('activeUsers', '2026-10-25')).toMatchObject({ value: 40, completeness: 'partial' });
    expect(v('engagementRate', '2026-10-24')?.value).toBe(0.61);
    expect(v('sessions', '2026-10-25', 'Organic Search')?.value).toBe(30);
    // Visitors per hour (the busy hour) and each event's count (custom events).
    expect(v('activeUsers', '2026-10-24', 'hour:22')?.value).toBe(61);
    expect(v('eventCount', '2026-10-24', 'event:sign_up')?.value).toBe(34);
    expect(points.some((p) => /login|auth/i.test(p.metric))).toBe(false);
  });

  it('syncs Search Console (last 3 days partial) and Play vitals up to their freshness', async () => {
    const fake = fakeGoogle();
    const { points, gaps } = await connector(fake).sync!(ctx(), {
      scopes: [
        { resourceType: 'google_search_console_site', externalId: 'sc-domain:shop.example' },
        { resourceType: 'google_play_app', externalId: 'com.acme.shop' },
      ],
      days: 28,
    });
    expect(gaps).toEqual([]);
    expect(points.find((p) => p.metric === 'clicks' && p.day === '2026-10-20')).toMatchObject({
      value: 12,
      completeness: 'complete',
    });
    expect(points.find((p) => p.metric === 'clicks' && p.day === '2026-10-23')).toMatchObject({
      value: 3,
      completeness: 'partial',
    });
    const crash = fake.calls.find((c) => c.url.pathname.endsWith('crashRateMetricSet:query'))!;
    expect(JSON.parse(crash.body).timelineSpec).toEqual({
      aggregationPeriod: 'DAILY',
      startTime: { year: 2026, month: 9, day: 27, timeZone: { id: 'America/Los_Angeles' } },
      endTime: { year: 2026, month: 10, day: 24, timeZone: { id: 'America/Los_Angeles' } },
    });
    expect(points.find((p) => p.metric === 'playUserPerceivedCrashRate')).toMatchObject({
      externalId: 'com.acme.shop',
      day: '2026-10-23',
      value: 0.0101,
    });
    expect(points.find((p) => p.metric === 'playUserPerceivedAnrRate')?.value).toBe(0.003);
    expect(points.find((p) => p.metric === 'playDistinctUsers')?.value).toBe(850);
  });

  it('a GA4 quota error is rate_limited, never zero values (Review Focus #5)', async () => {
    const fake = fakeGoogle((c) =>
      c.url.pathname.endsWith(':runReport')
        ? {
            status: 429,
            body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Exhausted property tokens' } },
          }
        : undefined,
    );
    await expect(
      connector(fake).sync!(ctx(), {
        scopes: [{ resourceType: 'google_ga4_property', externalId: 'properties/123' }],
        days: 3,
      }),
    ).rejects.toMatchObject({ reason: 'rate_limited' });
  });

  it('a service denied during sync becomes a gap; the others still sync', async () => {
    const fake = fakeGoogle((c) =>
      c.url.hostname === 'www.googleapis.com'
        ? {
            status: 403,
            body: {
              error: {
                status: 'PERMISSION_DENIED',
                message: 'Google Search Console API has not been used in project 1 before or it is disabled.',
              },
            },
          }
        : undefined,
    );
    const { points, gaps } = await connector(fake).sync!(ctx(), {
      scopes: [
        { resourceType: 'google_search_console_site', externalId: 'sc-domain:shop.example' },
        { resourceType: 'google_ga4_property', externalId: 'properties/123' },
      ],
      days: 3,
    });
    expect(gaps).toEqual([
      'Search Console: Google Search Console API has not been used in project 1 before or it is disabled.',
    ]);
    expect(points.some((p) => p.metric === 'activeUsers')).toBe(true);
  });
});

describe('Google service account keys (no Google sign-in)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyFile = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'service_account',
      project_id: 'acme-prod',
      private_key_id: 'kid',
      private_key: pem,
      client_email: 'pcp-reader@acme-prod.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token',
      ...over,
    });
  const saCtx = (granted: string[] = SERVICE_ACCOUNT_SCOPES, key = keyFile()): ExecutionContext => ({
    ...ctx(granted),
    credentials: async () => ({ serviceAccountKey: key }),
  });

  it('parses a key file and names what is wrong with a bad one, without echoing the key', () => {
    expect(parseServiceAccountKey(keyFile())).toMatchObject({
      clientEmail: 'pcp-reader@acme-prod.iam.gserviceaccount.com',
      projectId: 'acme-prod',
    });
    expect(() => parseServiceAccountKey('not json')).toThrow(/not JSON/);
    expect(() => parseServiceAccountKey(keyFile({ type: 'authorized_user' }))).toThrow(
      /not a service account/,
    );
    expect(() => parseServiceAccountKey(keyFile({ client_email: 'me@gmail.com' }))).toThrow(/client_email/);
    expect(() => parseServiceAccountKey(keyFile({ private_key: 'secret-but-broken' }))).toThrow(
      /^The key has no valid private key \(private_key\)$/,
    );
  });

  it('signs a JWT bearer grant for every scope except Ads; no client secret or refresh token is sent', async () => {
    const fake = fakeGoogle();
    expect(await connector(fake).validate(saCtx())).toEqual({ ok: true });
    const token = fake.calls.find((c) => c.url.hostname === 'oauth2.googleapis.com')!;
    const form = Object.fromEntries(new URLSearchParams(token.body));
    expect(Object.keys(form).sort()).toEqual(['assertion', 'grant_type']);
    expect(form.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p, sig] = form.assertion!.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({
      iss: 'pcp-reader@acme-prod.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 3600,
    });
    expect(claims.scope.split(' ')).not.toContain(`${SCOPE_PREFIX}adwords`);
    expect(claims.scope.split(' ')).toContain(`${SCOPE_PREFIX}analytics.readonly`);
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${h}.${p}`),
        createPublicKey(privateKey),
        Buffer.from(sig, 'base64url'),
      ),
    ).toBe(true);
  });

  it('a key Google refuses (deleted or disabled) is reauthorization_required', async () => {
    const fake = fakeGoogle((c) =>
      c.url.hostname === 'oauth2.googleapis.com'
        ? { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }
        : undefined,
    );
    await expect(connector(fake).validate(saCtx())).rejects.toMatchObject({
      reason: 'reauthorization_required',
      message: expect.stringContaining('Invalid JWT Signature.'),
    });
  });

  it('serviceAccess probes every service whatever the stored scopes say and names the denied ones', async () => {
    const fake = fakeGoogle((c) =>
      c.url.hostname === 'www.googleapis.com' || c.url.hostname.startsWith('playdev')
        ? { status: 403, body: { error: { message: 'The caller does not have permission' } } }
        : undefined,
    );
    expect(await connector(fake).serviceAccess(saCtx([]))).toEqual({
      services: ['ga4', 'firebase'],
      denied: [
        'Search Console: The caller does not have permission',
        'Play vitals: The caller does not have permission',
      ],
    });
  });
});

describe('Google connector safety (BR-08-04, BR-08-05)', () => {
  const sources = readdirSync(new URL('.', import.meta.url))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'));

  it('never references an Ads mutate method (TC-08-06)', () => {
    for (const s of sources) expect(s).not.toMatch(/mutate/i);
  });

  it('never maps GA4 login events to authentication counts (TC-08-09)', () => {
    for (const s of sources) expect(s).not.toMatch(/['"]login['"]/);
  });
});
