// A stand-in for Google's OAuth token endpoint and read APIs in the e2e stack (M13b exit gate).
// Every host is reached as /<host>/<path>, as the connector does with PCP_GOOGLE_API_URL.
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { URL, URLSearchParams } from 'node:url';

const P = 'https://www.googleapis.com/auth/';
// The member unticks Ads and BigQuery on the consent screen.
const GRANTED = [
  'analytics.readonly',
  'analytics.manage.users.readonly',
  'firebase.readonly',
  'cloud-platform.read-only',
  'monitoring.read',
  'logging.read',
  'playdeveloperreporting',
  'webmasters.readonly',
  'tagmanager.readonly',
].map((s) => P + s);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'RS256' })}.${b64({ email: 'e2e-ops@example.com', email_verified: true })}.sig`;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const ymd = (d) => ({ year: +d.slice(0, 4), month: +d.slice(5, 7), day: +d.slice(8, 10) });

function answer(method, path, body) {
  if (path === '/oauth2.googleapis.com/token') {
    const form = new URLSearchParams(body);
    if (form.get('grant_type') === 'authorization_code')
      return {
        access_token: 'at-e2e',
        refresh_token: 'rt-e2e',
        scope: [...GRANTED, 'openid'].join(' '),
        id_token: idToken,
      };
    return { access_token: 'at-e2e', expires_in: 3599 };
  }
  if (path === '/analyticsadmin.googleapis.com/v1beta/accountSummaries')
    return {
      accountSummaries: [
        { displayName: 'Acme', propertySummaries: [{ property: 'properties/123', displayName: 'Shop web' }] },
      ],
    };
  if (path === '/analyticsadmin.googleapis.com/v1beta/properties/123')
    return { name: 'properties/123', timeZone: 'UTC', currencyCode: 'USD' };
  if (path === '/analyticsadmin.googleapis.com/v1beta/properties/123/dataStreams')
    return {
      dataStreams: [
        {
          type: 'WEB_DATA_STREAM',
          displayName: 'web',
          webStreamData: { defaultUri: 'https://shop.example' },
        },
      ],
    };
  if (method === 'POST' && path === '/analyticsdata.googleapis.com/v1beta/properties/123:runReport') {
    const req = JSON.parse(body);
    const d = (s) => s.replaceAll('-', '');
    if (req.dimensions.length === 2)
      return {
        rows: [
          {
            dimensionValues: [{ value: d(day(-1)) }, { value: 'Organic Search' }],
            metricValues: [{ value: '90' }],
          },
        ],
      };
    const row = (s, n) => ({
      dimensionValues: [{ value: d(s) }],
      metricValues: [n, n - 5, n + 20, n * 3, 0.62, 4].map((v) => ({ value: String(v) })),
    });
    return { rows: [row(day(-1), 1234), row(day(0), 321)] };
  }
  if (path === '/www.googleapis.com/webmasters/v3/sites')
    return { siteEntry: [{ siteUrl: 'sc-domain:shop.example', permissionLevel: 'siteOwner' }] };
  if (method === 'POST' && path.startsWith('/www.googleapis.com/webmasters/v3/sites/'))
    return { rows: [{ keys: [day(-5)], clicks: 42, impressions: 900, ctr: 0.047, position: 7.4 }] };
  if (path === '/firebase.googleapis.com/v1beta1/projects')
    return { results: [{ projectId: 'acme-shop', displayName: 'Acme Shop' }] };
  if (path === '/firebase.googleapis.com/v1beta1/projects/acme-shop/androidApps')
    return { apps: [{ appId: '1:1:android:a', displayName: 'Shop Android', packageName: 'com.acme.shop' }] };
  if (path === '/firebase.googleapis.com/v1beta1/projects/acme-shop/iosApps') return { apps: [] };
  if (path === '/playdeveloperreporting.googleapis.com/v1beta1/apps:search')
    return { apps: [{ packageName: 'com.acme.shop', displayName: 'Shop on Play' }] };
  const set =
    /^\/playdeveloperreporting\.googleapis\.com\/v1beta1\/apps\/com\.acme\.shop\/(crashRate|anrRate)MetricSet(:query)?$/.exec(
      path,
    );
  if (set && !set[2])
    return {
      freshnessInfo: {
        freshnesses: [
          {
            aggregationPeriod: 'DAILY',
            latestEndTime: { ...ymd(day(-1)), timeZone: { id: 'America/Los_Angeles' } },
          },
        ],
      },
    };
  if (set)
    return {
      rows: [
        {
          startTime: ymd(day(-2)),
          metrics:
            set[1] === 'crashRate'
              ? [
                  { metric: 'crashRate', decimalValue: { value: '0.012' } },
                  { metric: 'userPerceivedCrashRate', decimalValue: { value: '0.0087' } },
                  { metric: 'distinctUsers', decimalValue: { value: '640' } },
                ]
              : [
                  { metric: 'anrRate', decimalValue: { value: '0.004' } },
                  { metric: 'userPerceivedAnrRate', decimalValue: { value: '0.003' } },
                ],
        },
      ],
    };
  return null;
}

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (pathname === '/healthz') return send(200, { ok: true });
    if (!pathname.startsWith('/oauth2.googleapis.com/') && req.headers.authorization !== 'Bearer at-e2e')
      return send(401, { error: { message: 'Request had invalid authentication credentials.' } });
    const a = answer(req.method, pathname, body);
    return a ? send(200, a) : send(404, { error: { message: 'Not found' } });
  });
}).listen(8080);
