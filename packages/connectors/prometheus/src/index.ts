import {
  ConnectorError,
  createHttpClient,
  type Connector,
  type DestinationOptions,
  type ExecutionContext,
} from '@pcp/connector-sdk';
import type { MetricResult, Observation } from '@pcp/shared-contracts';
import { isIP } from 'node:net';

export interface PrometheusOptions {
  fetch?: typeof fetch;
  destination?: DestinationOptions;
}

/** The hosted query limits (master plan §3), checked before anything is sent (BR-06-03). */
export const MAX_RANGE_DAYS = 31;
export const MAX_POINTS = 11_000;
const MAX_TARGETS = 1000;

interface PromResponse<T> {
  status: string;
  data?: T;
  error?: string;
}

/**
 * Prometheus Mode A (spec §11.4): the customer's Prometheus stays the store. Targets become
 * host and service observations; dashboards and the AI query it on demand, never copying series.
 */
export function createPrometheusConnector(opts: PrometheusOptions = {}): Connector {
  const http = createHttpClient(
    opts.fetch ? { fetch: opts.fetch } : { destination: opts.destination ?? { allowPrivate: false } },
  );

  function base(ctx: ExecutionContext) {
    const raw = String(ctx.config.baseUrl ?? '');
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ConnectorError('invalid_config', 'baseUrl must be a URL');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      throw new ConnectorError('invalid_config', 'baseUrl must be http(s)');
    return raw.replace(/\/+$/, '');
  }

  async function get<T>(ctx: ExecutionContext, path: string): Promise<T> {
    const c = await ctx.credentials().catch(() => ({}) as Record<string, string>);
    const headers: Record<string, string> = {};
    if (c.bearerToken) headers.authorization = `Bearer ${c.bearerToken}`;
    else if (c.username)
      headers.authorization = `Basic ${Buffer.from(`${c.username}:${c.password ?? ''}`).toString('base64')}`;
    const res = await http.request(`${base(ctx)}${path}`, { headers });
    if (res.status === 401)
      throw new ConnectorError('reauthorization_required', 'Prometheus rejected the credentials');
    if (res.status === 403) throw new ConnectorError('permission_denied', 'Prometheus refused the request');
    let body: PromResponse<T>;
    try {
      body = res.json<PromResponse<T>>();
    } catch {
      throw new ConnectorError('provider_unavailable', `Prometheus answered ${res.status} without JSON`);
    }
    if (res.status === 400 || res.status === 422)
      throw new ConnectorError('invalid_config', body.error ?? 'invalid query');
    if (res.status >= 400 || body.status !== 'success' || body.data === undefined)
      throw new ConnectorError('provider_unavailable', body.error ?? `Prometheus answered ${res.status}`);
    return body.data;
  }

  const observation = (
    ctx: ExecutionContext,
    resourceType: string,
    externalId: string,
    attributes: Record<string, unknown>,
  ): Observation => ({
    connectionId: ctx.connectionId,
    source: 'provider_api',
    provider: 'prometheus',
    resourceType,
    externalId,
    attributes,
    observedAt: new Date().toISOString(),
    method: 'prometheus_api',
    confidence: 0.9,
    evidence: { api: 'prometheus/v1' },
  });

  return {
    type: 'prometheus',
    version: '1.0.0',
    displayName: 'Prometheus',
    executionLocations: ['cloud'],
    credentialFields: [
      { name: 'bearerToken', label: 'Bearer token', secret: true, required: false },
      { name: 'username', label: 'Username', secret: false, required: false },
      { name: 'password', label: 'Password', secret: true, required: false },
    ],
    capabilities: () => ['config_validation', 'validate', 'discover', 'health', 'metrics'],
    configSchema: () => ({
      type: 'object',
      required: ['baseUrl'],
      properties: { baseUrl: { type: 'string', format: 'uri' } },
      additionalProperties: false,
    }),
    validateConfig(config) {
      const c = (config ?? {}) as { baseUrl?: unknown };
      try {
        const u = new URL(String(c.baseUrl));
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, errors: ['baseUrl'] };
        if (u.username || u.password) return { ok: false, errors: ['baseUrl must not contain credentials'] };
        return { ok: true };
      } catch {
        return { ok: false, errors: ['baseUrl'] };
      }
    },
    async validate(ctx) {
      const info = await get<{ version?: string }>(ctx, '/api/v1/status/buildinfo');
      return { ok: true, accountId: `Prometheus ${info.version ?? ''}`.trim() };
    },
    async discover(ctx) {
      const t = await get<{
        activeTargets?: Array<{ labels?: Record<string, string>; health?: string; scrapeUrl?: string }>;
      }>(ctx, '/api/v1/targets?state=active');
      const observations: Observation[] = [];
      for (const target of (t.activeTargets ?? []).slice(0, MAX_TARGETS)) {
        const labels = target.labels ?? {};
        const instance = labels.instance ?? '';
        const host = instance.replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '');
        observations.push(
          observation(ctx, 'prometheus_target', `${labels.job ?? ''}|${instance}`, {
            name: instance,
            instance,
            job: labels.job ?? null,
            health: target.health ?? 'unknown',
            ip: isIP(host) ? host : null,
            hostname: isIP(host) || !host ? null : host,
            labels,
          }),
        );
      }
      const rules = await get<{ groups?: Array<{ rules?: unknown[] }> }>(ctx, '/api/v1/rules').catch(() => ({
        groups: [],
      }));
      observations.push(
        observation(ctx, 'prometheus_server', 'server', {
          name: base(ctx),
          targets: observations.length,
          rules: (rules.groups ?? []).reduce((n, g) => n + (g.rules?.length ?? 0), 0),
        }),
      );
      return { observations };
    },
    async health(ctx) {
      const info = await get<{ version?: string }>(ctx, '/api/v1/status/buildinfo');
      return { ok: true, data: { version: info.version ?? null } };
    },
    async collect(ctx, q): Promise<MetricResult> {
      const start = Date.parse(q.start);
      const end = Date.parse(q.end);
      if (!(end > start)) throw new ConnectorError('invalid_config', 'end must be after start');
      if (end - start > MAX_RANGE_DAYS * 86_400_000)
        throw new ConnectorError(
          'invalid_config',
          `ranges over ${MAX_RANGE_DAYS} days are not allowed; narrow the range`,
        );
      const step = q.stepSeconds ?? Math.max(60, Math.ceil((end - start) / 1000 / 1000));
      if ((end - start) / 1000 / step + 1 > MAX_POINTS)
        throw new ConnectorError(
          'invalid_config',
          `more than ${MAX_POINTS} points per series; narrow the range or raise the step`,
        );
      const params = new URLSearchParams({
        query: q.promql,
        start: String(start / 1000),
        end: String(end / 1000),
        step: `${step}s`,
      });
      const data = await get<{
        result?: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
      }>(ctx, `/api/v1/query_range?${params}`);
      const series = (data.result ?? []).slice(0, 500).map((r) => ({
        labels: r.metric,
        points: r.values.map(([t, v]): [number, number | null] => {
          const n = Number(v);
          return [t, Number.isFinite(n) ? n : null];
        }),
      }));
      return {
        series,
        freshness: series.length ? 'current' : 'unavailable',
        completeness: (data.result ?? []).length > 500 ? 'partial' : 'complete',
        gaps: (data.result ?? []).length > 500 ? ['More than 500 series; showing the first 500'] : [],
      };
    },
  };
}

export const prometheusConnector = createPrometheusConnector();
