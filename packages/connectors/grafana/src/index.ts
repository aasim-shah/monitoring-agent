import {
  ConnectorError,
  createHttpClient,
  type Connector,
  type DestinationOptions,
  type ExecutionContext,
} from '@pcp/connector-sdk';
import type { Observation } from '@pcp/shared-contracts';

export interface GrafanaOptions {
  fetch?: typeof fetch;
  destination?: DestinationOptions;
}

/**
 * Grafana (WB-06 UC-06-09): a service account token reads dashboards and folders so asset pages
 * can link to them. Grafana is a link target only, never a data source of record (BR-06-04).
 */
export function createGrafanaConnector(opts: GrafanaOptions = {}): Connector {
  const http = createHttpClient(
    opts.fetch ? { fetch: opts.fetch } : { destination: opts.destination ?? { allowPrivate: false } },
  );

  const base = (ctx: ExecutionContext) => {
    const raw = String(ctx.config.baseUrl ?? '');
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    } catch {
      throw new ConnectorError('invalid_config', 'baseUrl must be an http(s) URL');
    }
    return raw.replace(/\/+$/, '');
  };

  async function get<T>(ctx: ExecutionContext, path: string): Promise<{ status: number; body: T | null }> {
    const { serviceAccountToken } = await ctx.credentials();
    const res = await http.request(`${base(ctx)}${path}`, {
      headers: { authorization: `Bearer ${serviceAccountToken ?? ''}`, accept: 'application/json' },
    });
    if (res.status === 401)
      throw new ConnectorError('reauthorization_required', 'Grafana rejected the service account token');
    let body: T | null = null;
    try {
      body = res.json<T>();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  return {
    type: 'grafana',
    version: '1.0.0',
    displayName: 'Grafana',
    executionLocations: ['cloud'],
    credentialFields: [{ name: 'serviceAccountToken', label: 'Service account token', secret: true }],
    capabilities: () => ['config_validation', 'validate', 'discover', 'health'],
    configSchema: () => ({
      type: 'object',
      required: ['baseUrl'],
      properties: { baseUrl: { type: 'string', format: 'uri' } },
      additionalProperties: false,
    }),
    validateConfig(config) {
      try {
        const u = new URL(String((config as { baseUrl?: unknown } | null)?.baseUrl));
        return u.protocol === 'https:' || u.protocol === 'http:'
          ? { ok: true }
          : { ok: false, errors: ['baseUrl'] };
      } catch {
        return { ok: false, errors: ['baseUrl'] };
      }
    },
    async validate(ctx) {
      const health = await get<{ database?: string; version?: string }>(ctx, '/api/health');
      if (health.status >= 400 || health.body?.database !== 'ok')
        throw new ConnectorError('provider_unavailable', 'Grafana health check failed');
      const search = await get<unknown[]>(ctx, '/api/search?limit=1');
      const accountId = `Grafana ${health.body.version ?? ''}`.trim();
      return search.status === 200
        ? { ok: true, accountId }
        : { ok: false, accountId, missingPermissions: ['Dashboards: Read'] };
    },
    async discover(ctx) {
      const res = await get<
        Array<{ uid: string; title: string; folderTitle?: string; url: string; tags?: string[] }>
      >(ctx, '/api/search?type=dash-db&limit=1000');
      if (res.status >= 400)
        throw new ConnectorError('permission_denied', 'the token cannot search dashboards');
      const observations: Observation[] = (res.body ?? []).map((d) => ({
        connectionId: ctx.connectionId,
        source: 'provider_api',
        provider: 'grafana',
        resourceType: 'grafana_dashboard',
        externalId: d.uid,
        attributes: {
          name: d.title,
          title: d.title,
          folder: d.folderTitle ?? 'General',
          url: `${base(ctx)}${d.url}`,
          tags: d.tags ?? [],
        },
        observedAt: new Date().toISOString(),
        method: 'grafana_api',
        confidence: 1,
        evidence: { api: 'grafana/search' },
      }));
      return { observations };
    },
    async health(ctx) {
      const health = await get<{ database?: string; version?: string }>(ctx, '/api/health');
      return health.body?.database === 'ok'
        ? { ok: true, data: { version: health.body.version ?? null } }
        : { ok: false, detail: 'Grafana health check failed' };
    },
  };
}

export const grafanaConnector = createGrafanaConnector();
