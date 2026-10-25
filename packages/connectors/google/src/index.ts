import {
  ConnectorError,
  createHttpClient,
  type Connector,
  type DestinationOptions,
  type ExecutionContext,
  type MetricPoint,
} from '@pcp/connector-sdk';
import type { Observation } from '@pcp/shared-contracts';
import { SERVICE_LABEL, SERVICE_SCOPE, type GoogleService } from './scopes.js';

export * from './scopes.js';

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  /**
   * Test stacks only (PCP_GOOGLE_API_URL with PCP_ALLOW_TEST_PROVIDERS=1): every Google host is
   * reached as `<apiUrl>/<host>/<path>`, e.g. `http://fake-google:8080/oauth2.googleapis.com/token`.
   */
  apiUrl?: string;
  fetch?: typeof fetch;
  destination?: DestinationOptions;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const HOST = {
  token: 'oauth2.googleapis.com',
  admin: 'analyticsadmin.googleapis.com',
  data: 'analyticsdata.googleapis.com',
  webmasters: 'www.googleapis.com',
  firebase: 'firebase.googleapis.com',
  play: 'playdeveloperreporting.googleapis.com',
} as const;

/** GA4 totals per day, in this order (WB-08 UC-08-04). `login` events are never read (BR-08-05). */
const GA4_METRICS = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'engagementRate', 'keyEvents'];
const SEARCH_METRICS = ['clicks', 'impressions', 'ctr', 'position'] as const;
/** Search Console keeps revising the most recent days. */
const SEARCH_PARTIAL_DAYS = 3;
const PLAY_SETS = {
  crashRateMetricSet: {
    crashRate: 'playCrashRate',
    userPerceivedCrashRate: 'playUserPerceivedCrashRate',
    distinctUsers: 'playDistinctUsers',
  },
  anrRateMetricSet: { anrRate: 'playAnrRate', userPerceivedAnrRate: 'playUserPerceivedAnrRate' },
} as const;

/** A service the grant or the provider refused; the rest of the run continues. */
class ServiceDenied extends Error {}

interface YMD {
  year: number;
  month: number;
  day: number;
}
const ymd = (d: YMD) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const toYMD = (day: string): YMD => {
  const [year, month, d] = day.split('-').map(Number) as [number, number, number];
  return { year, month, day: d };
};
/** The calendar date at `now` in `timeZone` (GA4 reports in the property's timezone). */
const localDay = (now: Date, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

/**
 * Google (WB-08, spec §7.2): one OAuth grant reads GA4, Search Console, Firebase, and Play vitals.
 * Read-only: the connector calls list, get, and report endpoints only (BR-08-04).
 */
export function createGoogleConnector(opts: GoogleOptions): Connector {
  const http = createHttpClient({
    ...(opts.fetch ? { fetch: opts.fetch } : { destination: opts.destination ?? { allowPrivate: false } }),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
  const now = opts.now ?? (() => new Date());
  const url = (host: string, path: string) =>
    opts.apiUrl ? `${opts.apiUrl.replace(/\/+$/, '')}/${host}${path}` : `https://${host}${path}`;

  const granted = (ctx: ExecutionContext, s: GoogleService) =>
    (ctx.grantedScopes ?? []).includes(SERVICE_SCOPE[s]);

  /** A fresh access token per execution; `invalid_grant` means the user revoked access (UC-08-10). */
  async function accessToken(ctx: ExecutionContext): Promise<string> {
    const { refreshToken } = await ctx.credentials();
    if (!refreshToken) throw new ConnectorError('reauthorization_required', 'no Google refresh token stored');
    const res = await http.request(url(HOST.token, '/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const body = safeJson<{ access_token?: string; error?: string }>(res);
    if (res.status === 400 || res.status === 401) {
      if (body?.error === 'invalid_grant' || body?.error === 'unauthorized_client')
        throw new ConnectorError(
          'reauthorization_required',
          'Google access was revoked or expired; reconnect',
        );
      throw new ConnectorError(
        'invalid_config',
        `Google token endpoint refused the client: ${body?.error ?? res.status}`,
      );
    }
    if (res.status !== 200 || !body?.access_token)
      throw new ConnectorError('provider_unavailable', `Google token endpoint answered ${res.status}`);
    return body.access_token;
  }

  function safeJson<T>(res: { json<U>(): U }): T | null {
    try {
      return res.json<T>();
    } catch {
      return null;
    }
  }

  /** One API call. 401 needs a new grant; 403 denies just this service; 429 is the quota. */
  async function call<T>(token: string, host: string, path: string, body?: unknown): Promise<T> {
    const res = await http.request(url(host, path), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = safeJson<T & { error?: { message?: string; status?: string } }>(res);
    if (res.status === 200) return parsed as T;
    const message = parsed?.error?.message ?? `Google answered ${res.status}`;
    if (res.status === 401) throw new ConnectorError('reauthorization_required', message);
    if (res.status === 403 || res.status === 404) throw new ServiceDenied(message);
    if (res.status === 429) throw new ConnectorError('rate_limited', message);
    throw new ConnectorError('provider_unavailable', message);
  }

  /** Runs one service; a denial becomes a named gap, anything else stops the run. */
  async function service<T>(name: GoogleService, gaps: string[], fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ServiceDenied) {
        gaps.push(`${SERVICE_LABEL[name]}: ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  const READ_SERVICES: GoogleService[] = ['ga4', 'searchConsole', 'firebase', 'play'];

  const probes: Record<string, (t: string) => Promise<unknown>> = {
    ga4: (t) => call(t, HOST.admin, '/v1beta/accountSummaries?pageSize=1'),
    searchConsole: (t) => call(t, HOST.webmasters, '/webmasters/v3/sites'),
    firebase: (t) => call(t, HOST.firebase, '/v1beta1/projects?pageSize=1'),
    play: (t) => call(t, HOST.play, '/v1beta1/apps:search?pageSize=1'),
  };

  async function ga4Properties(token: string, ctx: ExecutionContext): Promise<Observation[]> {
    const out: Observation[] = [];
    const sums = await call<{
      accountSummaries?: Array<{
        displayName?: string;
        propertySummaries?: Array<{ property: string; displayName?: string }>;
      }>;
    }>(token, HOST.admin, '/v1beta/accountSummaries?pageSize=200');
    for (const account of sums.accountSummaries ?? [])
      for (const p of (account.propertySummaries ?? []).slice(0, 200)) {
        const detail = await call<{ timeZone?: string; currencyCode?: string }>(
          token,
          HOST.admin,
          `/v1beta/${p.property}`,
        );
        const streams = await call<{
          dataStreams?: Array<{
            type: string;
            displayName?: string;
            webStreamData?: { defaultUri?: string };
            androidAppStreamData?: { packageName?: string };
            iosAppStreamData?: { bundleId?: string };
          }>;
        }>(token, HOST.admin, `/v1beta/${p.property}/dataStreams`);
        out.push(
          observation(ctx, 'google_ga4_property', p.property, {
            name: p.displayName ?? p.property,
            account: account.displayName ?? null,
            timeZone: detail.timeZone ?? 'UTC',
            currencyCode: detail.currencyCode ?? null,
            streams: (streams.dataStreams ?? []).map((s) =>
              s.webStreamData
                ? { type: 'web', name: s.displayName ?? '', url: s.webStreamData.defaultUri ?? null }
                : s.androidAppStreamData
                  ? {
                      type: 'android',
                      name: s.displayName ?? '',
                      packageName: s.androidAppStreamData.packageName ?? null,
                    }
                  : {
                      type: 'ios',
                      name: s.displayName ?? '',
                      bundleId: s.iosAppStreamData?.bundleId ?? null,
                    },
            ),
          }),
        );
      }
    return out;
  }

  async function searchSites(token: string, ctx: ExecutionContext): Promise<Observation[]> {
    const r = await call<{ siteEntry?: Array<{ siteUrl: string; permissionLevel?: string }> }>(
      token,
      HOST.webmasters,
      '/webmasters/v3/sites',
    );
    return (r.siteEntry ?? [])
      .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
      .map((s) =>
        observation(ctx, 'google_search_console_site', s.siteUrl, {
          name: s.siteUrl.replace(/^sc-domain:/, ''),
          permissionLevel: s.permissionLevel ?? null,
        }),
      );
  }

  async function firebaseApps(token: string, ctx: ExecutionContext): Promise<Observation[]> {
    const out: Observation[] = [];
    const projects = await call<{ results?: Array<{ projectId: string; displayName?: string }> }>(
      token,
      HOST.firebase,
      '/v1beta1/projects?pageSize=100',
    );
    for (const p of projects.results ?? []) {
      out.push(
        observation(ctx, 'google_firebase_project', p.projectId, { name: p.displayName ?? p.projectId }),
      );
      for (const platform of ['android', 'ios'] as const) {
        const apps = await call<{
          apps?: Array<{ appId: string; displayName?: string; packageName?: string; bundleId?: string }>;
        }>(token, HOST.firebase, `/v1beta1/projects/${p.projectId}/${platform}Apps?pageSize=100`);
        for (const a of apps.apps ?? [])
          out.push(
            observation(ctx, 'google_firebase_app', a.appId, {
              name: a.displayName ?? a.packageName ?? a.bundleId ?? a.appId,
              platform,
              project: p.projectId,
              packageName: a.packageName ?? null,
              bundleId: a.bundleId ?? null,
            }),
          );
      }
    }
    return out;
  }

  async function playApps(token: string, ctx: ExecutionContext): Promise<Observation[]> {
    const r = await call<{ apps?: Array<{ packageName: string; displayName?: string }> }>(
      token,
      HOST.play,
      '/v1beta1/apps:search?pageSize=100',
    );
    return (r.apps ?? []).map((a) =>
      observation(ctx, 'google_play_app', a.packageName, {
        name: a.displayName ?? a.packageName,
        packageName: a.packageName,
      }),
    );
  }

  async function ga4Points(token: string, property: string, days: number): Promise<MetricPoint[]> {
    const detail = await call<{ timeZone?: string }>(token, HOST.admin, `/v1beta/${property}`);
    const today = localDay(now(), detail.timeZone ?? 'UTC');
    const dateRanges = [{ startDate: addDays(today, -(days - 1)), endDate: today }];
    const day = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    const point = (
      metric: string,
      d: string,
      value: string | undefined,
      dimension?: string,
    ): MetricPoint => ({
      resourceType: 'google_ga4_property',
      externalId: property,
      metric,
      ...(dimension ? { dimension } : {}),
      day: d,
      value: value === undefined || value === '' ? null : Number(value),
      completeness: d >= today ? 'partial' : 'complete',
    });
    type Report = {
      rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }>;
    };
    const totals = await call<Report>(token, HOST.data, `/v1beta/${property}:runReport`, {
      dateRanges,
      dimensions: [{ name: 'date' }],
      metrics: GA4_METRICS.map((name) => ({ name })),
      returnPropertyQuota: true,
    });
    const points: MetricPoint[] = [];
    for (const r of totals.rows ?? []) {
      const d = day(r.dimensionValues[0]!.value);
      GA4_METRICS.forEach((m, i) => points.push(point(m, d, r.metricValues[i]?.value)));
    }
    const channels = await call<Report>(token, HOST.data, `/v1beta/${property}:runReport`, {
      dateRanges,
      dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      limit: 1000,
      returnPropertyQuota: true,
    });
    for (const r of channels.rows ?? [])
      points.push(
        point(
          'sessions',
          day(r.dimensionValues[0]!.value),
          r.metricValues[0]?.value,
          r.dimensionValues[1]!.value || '(other)',
        ),
      );
    // Visitors per hour of each day (the report's busy hour) and every event's daily count
    // (custom events). Breakdowns carry a prefix so they never mix with the channel groups.
    for (const [second, metric, prefix] of [
      ['hour', 'activeUsers', 'hour'],
      ['eventName', 'eventCount', 'event'],
    ] as const) {
      const r = await call<Report>(token, HOST.data, `/v1beta/${property}:runReport`, {
        dateRanges,
        dimensions: [{ name: 'date' }, { name: second }],
        metrics: [{ name: metric }],
        limit: 5000,
        returnPropertyQuota: true,
      });
      for (const row of r.rows ?? [])
        points.push(
          point(
            metric,
            day(row.dimensionValues[0]!.value),
            row.metricValues[0]?.value,
            `${prefix}:${row.dimensionValues[1]!.value}`,
          ),
        );
    }
    return points;
  }

  async function searchPoints(token: string, site: string, days: number): Promise<MetricPoint[]> {
    const today = now().toISOString().slice(0, 10);
    const r = await call<{
      rows?: Array<{ keys: string[] } & Record<(typeof SEARCH_METRICS)[number], number>>;
    }>(token, HOST.webmasters, `/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      startDate: addDays(today, -(days - 1)),
      endDate: today,
      dimensions: ['date'],
      dataState: 'all',
      rowLimit: 1000,
    });
    const settled = addDays(today, -(SEARCH_PARTIAL_DAYS - 1));
    return (r.rows ?? []).flatMap((row) =>
      SEARCH_METRICS.map((metric) => ({
        resourceType: 'google_search_console_site',
        externalId: site,
        metric,
        day: row.keys[0]!,
        value: typeof row[metric] === 'number' ? row[metric] : null,
        completeness: row.keys[0]! >= settled ? ('partial' as const) : ('complete' as const),
      })),
    );
  }

  async function playPoints(token: string, pkg: string, days: number): Promise<MetricPoint[]> {
    const points: MetricPoint[] = [];
    for (const [set, names] of Object.entries(PLAY_SETS)) {
      const meta = await call<{
        freshnessInfo?: {
          freshnesses?: Array<{
            aggregationPeriod: string;
            latestEndTime: YMD & { timeZone?: { id: string } };
          }>;
        };
      }>(token, HOST.play, `/v1beta1/apps/${pkg}/${set}`);
      const latest = meta.freshnessInfo?.freshnesses?.find(
        (f) => f.aggregationPeriod === 'DAILY',
      )?.latestEndTime;
      if (!latest) continue;
      const tz = latest.timeZone ?? { id: 'America/Los_Angeles' };
      const end = ymd(latest);
      const r = await call<{
        rows?: Array<{
          startTime: YMD;
          metrics: Array<{ metric: string; decimalValue?: { value: string } }>;
        }>;
      }>(token, HOST.play, `/v1beta1/apps/${pkg}/${set}:query`, {
        timelineSpec: {
          aggregationPeriod: 'DAILY',
          startTime: { ...toYMD(addDays(end, -(days - 1))), timeZone: tz },
          endTime: { ...toYMD(end), timeZone: tz },
        },
        metrics: Object.keys(names),
        pageSize: 1000,
      });
      for (const row of r.rows ?? [])
        for (const m of row.metrics) {
          const metric = (names as Record<string, string>)[m.metric];
          if (!metric) continue;
          points.push({
            resourceType: 'google_play_app',
            externalId: pkg,
            metric,
            day: ymd(row.startTime),
            value: m.decimalValue?.value === undefined ? null : Number(m.decimalValue.value),
            completeness: 'complete',
          });
        }
    }
    return points;
  }

  return {
    type: 'google',
    version: '1.0.0',
    displayName: 'Google',
    executionLocations: ['cloud'],
    // Filled by the OAuth callback, never typed in (WB-08 UC-08-01).
    credentialFields: [],
    capabilities: () => ['validate', 'discover', 'health', 'sync'],
    configSchema: () => ({ type: 'object', properties: {}, additionalProperties: false }),

    async validate(ctx) {
      const token = await accessToken(ctx);
      const missing: string[] = [];
      let working = 0;
      for (const s of READ_SERVICES) {
        if (!granted(ctx, s)) continue;
        const ok = await service(s, missing, () => probes[s]!(token));
        if (ok !== null) working++;
      }
      if (working === 0)
        return {
          ok: false,
          missingPermissions: missing.length ? missing : ['Google data access was not granted'],
        };
      return { ok: true, ...(missing.length ? { missingPermissions: missing } : {}) };
    },

    async discover(ctx) {
      const token = await accessToken(ctx);
      const gaps: string[] = [];
      const observations: Observation[] = [];
      const lists: Array<[GoogleService, (t: string, c: ExecutionContext) => Promise<Observation[]>]> = [
        ['ga4', ga4Properties],
        ['searchConsole', searchSites],
        ['firebase', firebaseApps],
        ['play', playApps],
      ];
      for (const [s, list] of lists) {
        if (!granted(ctx, s)) continue;
        observations.push(...((await service(s, gaps, () => list(token, ctx))) ?? []));
      }
      return { observations };
    },

    async health(ctx) {
      await accessToken(ctx);
      return { ok: true };
    },

    async sync(ctx, input) {
      const token = await accessToken(ctx);
      const gaps: string[] = [];
      const points: MetricPoint[] = [];
      const days = Math.max(1, Math.min(90, input.days));
      for (const scope of input.scopes) {
        const run =
          scope.resourceType === 'google_ga4_property' && granted(ctx, 'ga4')
            ? (['ga4', () => ga4Points(token, scope.externalId, days)] as const)
            : scope.resourceType === 'google_search_console_site' && granted(ctx, 'searchConsole')
              ? (['searchConsole', () => searchPoints(token, scope.externalId, days)] as const)
              : scope.resourceType === 'google_play_app' && granted(ctx, 'play')
                ? (['play', () => playPoints(token, scope.externalId, days)] as const)
                : null;
        if (!run) continue;
        points.push(...((await service(run[0], gaps, run[1])) ?? []));
      }
      return { points, gaps: [...new Set(gaps)] };
    },
  };
}

function observation(
  ctx: ExecutionContext,
  resourceType: string,
  externalId: string,
  attributes: Record<string, unknown>,
): Observation {
  return {
    connectionId: ctx.connectionId,
    source: 'provider_api',
    provider: 'google',
    resourceType,
    externalId,
    attributes,
    observedAt: new Date().toISOString(),
    method: 'google_api',
    confidence: 1,
    evidence: { api: resourceType },
  };
}
