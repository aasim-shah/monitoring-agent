import {
  ConnectorError,
  createHttpClient,
  redactSecrets,
  type Connector,
  type ExecutionContext,
} from '@pcp/connector-sdk';
import { readPath } from './mapping.js';

export { readPath } from './mapping.js';

/** Hard limits (WB-07 UC-07-07): 1 MB responses, 10 s timeout, at most 100 pages. */
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_PAGES = 100;

interface Endpoint {
  name: string;
  path: string;
  query?: Record<string, string>;
  itemsPath?: string;
  pagination?: { param: string; start: number; max: number };
  /** `path` is a JSONPath, or `$count` for the number of items across pages. */
  metrics: Array<{ name: string; path: string; unit?: string }>;
}

interface Config {
  baseUrl: string;
  auth: { kind: 'none' | 'api_key_header' | 'bearer'; headerName?: string };
  endpoints: Endpoint[];
  allowPrivate?: boolean;
  allowlist?: string[];
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

function parseConfig(raw: unknown): Config {
  const c = raw as Partial<Config>;
  const errors: string[] = [];
  let base: URL | undefined;
  try {
    base = new URL(String(c.baseUrl));
    if (base.protocol !== 'https:' && base.protocol !== 'http:') errors.push('baseUrl must be http(s)');
    if (base.username || base.password) errors.push('baseUrl must not contain credentials');
  } catch {
    errors.push('baseUrl must be a URL');
  }
  const kind = c.auth?.kind ?? 'none';
  if (!['none', 'api_key_header', 'bearer'].includes(kind)) errors.push('auth.kind is invalid');
  if (c.auth?.headerName !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(c.auth.headerName))
    errors.push('auth.headerName is invalid');
  if (!Array.isArray(c.endpoints) || c.endpoints.length === 0 || c.endpoints.length > 20)
    errors.push('1-20 endpoints are required');
  for (const e of c.endpoints ?? []) {
    if (!NAME.test(e.name ?? '')) errors.push(`endpoint name ${e.name} is invalid`);
    // Relative paths only: an endpoint can never leave the base URL's host.
    if (typeof e.path !== 'string' || !e.path.startsWith('/') || e.path.startsWith('//'))
      errors.push(`endpoint ${e.name} path must start with a single /`);
    if (
      e.pagination &&
      (!Number.isInteger(e.pagination.max) || e.pagination.max < 1 || e.pagination.max > MAX_PAGES)
    )
      errors.push(`endpoint ${e.name} pagination.max must be 1-${MAX_PAGES}`);
    if (e.pagination && !e.itemsPath) errors.push(`endpoint ${e.name} pagination needs itemsPath`);
    for (const m of e.metrics ?? []) {
      if (!NAME.test(m.name ?? '')) errors.push(`metric name ${m.name} is invalid`);
      if (m.path !== '$count') {
        try {
          readPath({}, m.path);
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
    }
  }
  if (errors.length) throw new ConnectorError('invalid_config', errors.join('; '));
  return c as Config;
}

function client(ctx: ExecutionContext, cfg: Config) {
  // Central execution never reaches private addresses, whatever the config says (BR-07-06).
  const isPrivate = ctx.executionLocation === 'private' && cfg.allowPrivate === true;
  return createHttpClient({
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_BYTES,
    retries: 1,
    destination: { allowPrivate: isPrivate, allowlist: isPrivate ? cfg.allowlist : [] },
  });
}

async function call(ctx: ExecutionContext, cfg: Config, endpoint: Endpoint, page?: number) {
  const { token } = cfg.auth.kind === 'none' ? { token: '' } : await ctx.credentials();
  const url = new URL(endpoint.path, cfg.baseUrl);
  for (const [k, v] of Object.entries(endpoint.query ?? {})) url.searchParams.set(k, v);
  if (endpoint.pagination && page !== undefined)
    url.searchParams.set(endpoint.pagination.param, String(page));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.auth.kind === 'bearer') headers.authorization = `Bearer ${token}`;
  if (cfg.auth.kind === 'api_key_header') headers[cfg.auth.headerName ?? 'X-API-Key'] = token ?? '';
  const secrets = token ? [token] : [];
  try {
    const res = await client(ctx, cfg).request(url.toString(), { headers });
    if (res.status === 401)
      throw new ConnectorError('reauthorization_required', `${endpoint.name}: provider returned 401`);
    if (res.status === 403)
      throw new ConnectorError('permission_denied', `${endpoint.name}: provider returned 403`);
    if (res.status < 200 || res.status >= 300)
      throw new ConnectorError('provider_unavailable', `${endpoint.name}: provider returned ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    let body: unknown;
    try {
      body = res.json();
    } catch {
      throw new ConnectorError(
        'invalid_response',
        `${endpoint.name}: expected JSON, got ${type.split(';')[0] || 'unknown content'}`,
      );
    }
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof ConnectorError)
      throw new ConnectorError(err.reason, redactSecrets(err.message, secrets));
    throw new ConnectorError('provider_unavailable', redactSecrets(String(err), secrets));
  }
}

async function readEndpoint(ctx: ExecutionContext, cfg: Config, e: Endpoint) {
  const warnings: string[] = [];
  const first = await call(ctx, cfg, e, e.pagination?.start);
  let pages = 1;
  let items = e.itemsPath ? ((readPath(first.body, e.itemsPath) as unknown[] | undefined) ?? []) : [];
  if (e.pagination && Array.isArray(items)) {
    let page = e.pagination.start;
    let last = items;
    while (Array.isArray(last) && last.length > 0) {
      if (pages >= Math.min(e.pagination.max, MAX_PAGES)) {
        warnings.push(`stopped after ${pages} pages`);
        break;
      }
      page += 1;
      const next = await call(ctx, cfg, e, page);
      pages += 1;
      last = (readPath(next.body, e.itemsPath!) as unknown[] | undefined) ?? [];
      if (Array.isArray(last)) items = items.concat(last);
    }
  }
  const metrics: Record<string, number | null> = {};
  for (const m of e.metrics) {
    const raw =
      m.path === '$count' ? (Array.isArray(items) ? items.length : undefined) : readPath(first.body, m.path);
    const n =
      typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (Number.isFinite(n)) metrics[m.name] = n;
    else {
      metrics[m.name] = null;
      warnings.push(`${m.name}: no number at ${m.path}`);
    }
  }
  return { name: e.name, status: first.status, pages, metrics, warnings };
}

export const customHttpConnector: Connector = {
  type: 'custom-http',
  version: '1.0.0',
  displayName: 'Custom REST API',
  executionLocations: ['cloud', 'private'],
  credentialFields: [{ name: 'token', label: 'API key or token', secret: true }],
  capabilities: () => ['config_validation', 'validate', 'health'],
  configSchema: () => ({
    type: 'object',
    required: ['baseUrl', 'endpoints'],
    properties: {
      baseUrl: { type: 'string', format: 'uri' },
      auth: {
        type: 'object',
        properties: { kind: { enum: ['none', 'api_key_header', 'bearer'] }, headerName: { type: 'string' } },
      },
      endpoints: { type: 'array', minItems: 1, maxItems: 20 },
      allowPrivate: { type: 'boolean', description: 'Private worker only: reach allowlisted internal hosts' },
      allowlist: { type: 'array', items: { type: 'string' } },
    },
  }),
  validateConfig(config) {
    try {
      parseConfig(config);
      return { ok: true };
    } catch (e) {
      return { ok: false, errors: [(e as Error).message] };
    }
  },
  async validate(ctx) {
    const cfg = parseConfig(ctx.config);
    await call(ctx, cfg, cfg.endpoints[0]!, cfg.endpoints[0]!.pagination?.start);
    return { ok: true, accountId: new URL(cfg.baseUrl).host };
  },
  async health(ctx) {
    const cfg = parseConfig(ctx.config);
    const endpoints = [];
    for (const e of cfg.endpoints) endpoints.push(await readEndpoint(ctx, cfg, e));
    return { ok: true, data: { endpoints } };
  },
};
