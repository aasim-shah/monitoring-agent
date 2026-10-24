import { Inject, Injectable } from '@nestjs/common';
import type { MetricQuery, MetricResult, TenantContext } from '@pcp/shared-contracts';
import type { AppConfig } from '../../config.js';
import { ApiException } from '../../common/errors.js';
import { APP_CONFIG, CLOCK } from '../../tokens.js';
import { MAX_SERIES, QUERY_TIMEOUT_MS, planRange, toGrid, widenWindows } from './limits.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QueryScope {
  productId: string;
  agentId?: string;
}

interface VmResponse<T> {
  status: string;
  error?: string;
  data?: { resultType: string; result: T[] };
}

/**
 * The only read path to telemetry storage (D16, BR-04-05). Every query carries
 * `extra_label=tenant_id=<org>` and an `extra_filters` product (and agent) matcher, so
 * PromQL can never reach another tenant's or product's series.
 */
@Injectable()
export class TelemetryQueryService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  private params(ctx: TenantContext, scope: QueryScope): URLSearchParams {
    if (!UUID.test(scope.productId) || (scope.agentId && !UUID.test(scope.agentId)))
      throw new ApiException(400, 'invalid_scope', 'Invalid telemetry scope');
    const matchers = [`product_id="${scope.productId}"`];
    if (scope.agentId) matchers.push(`agent_id="${scope.agentId}"`);
    return new URLSearchParams({
      extra_label: `tenant_id=${ctx.organizationId}`,
      'extra_filters[]': `{${matchers.join(',')}}`,
      timeout: `${QUERY_TIMEOUT_MS / 1000}s`,
    });
  }

  private async call<T>(path: string, params: URLSearchParams, base = this.config.vmQueryUrl): Promise<T[]> {
    if (!base) throw new ApiException(503, 'telemetry_unavailable', 'Telemetry storage is not configured');
    let res: Response;
    try {
      res = await fetch(`${base}${path}?${params}`, {
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });
    } catch {
      throw new ApiException(503, 'telemetry_unavailable', 'Telemetry storage did not answer in time');
    }
    const body = (await res.json().catch(() => ({ status: 'error' }))) as VmResponse<T>;
    if (res.status === 422 || res.status === 400)
      throw new ApiException(400, 'invalid_query', body.error ?? 'Invalid query');
    if (!res.ok || body.status !== 'success' || !body.data)
      throw new ApiException(503, 'telemetry_unavailable', 'Telemetry storage returned an error');
    if (body.data.result.length > MAX_SERIES)
      throw new ApiException(
        422,
        'too_many_series',
        `Query returns more than ${MAX_SERIES} series; narrow it`,
      );
    return body.data.result;
  }

  async query(ctx: TenantContext, q: MetricQuery, scope: QueryScope): Promise<MetricResult> {
    let plan;
    try {
      plan = planRange(new Date(q.start), new Date(q.end), q.stepSeconds, this.now(), this.config.rollups);
    } catch (err) {
      throw new ApiException(400, 'invalid_range', (err as Error).message);
    }
    const params = this.params(ctx, scope);
    const longterm = plan.source === 'longterm';
    params.set('query', longterm ? widenWindows(q.promql, plan.stepSeconds) : q.promql);
    params.set('start', String(plan.startS));
    params.set('end', String(plan.endS));
    params.set('step', `${plan.stepSeconds}s`);
    const result = await this.call<{ metric: Record<string, string>; values: Array<[number, string]> }>(
      '/api/v1/query_range',
      params,
      longterm ? this.config.rollups!.url : this.config.vmQueryUrl,
    );
    return {
      series: result.map((r) => ({
        labels: r.metric,
        points: toGrid(r.values, plan.startS, plan.endS, plan.stepSeconds),
      })),
      freshness: result.length ? 'current' : 'unavailable',
      completeness: plan.gaps.length ? 'partial' : 'complete',
      gaps: plan.gaps,
    };
  }

  /** Instant query at now; returns label sets with their value. */
  async instant(
    ctx: TenantContext,
    promql: string,
    scope: QueryScope,
    at?: Date,
  ): Promise<Array<{ labels: Record<string, string>; value: number | null }>> {
    const params = this.params(ctx, scope);
    params.set('query', promql);
    params.set('time', String(Math.floor((at ?? this.now()).getTime() / 1000)));
    const result = await this.call<{ metric: Record<string, string>; value: [number, string] }>(
      '/api/v1/query',
      params,
    );
    return result.map((r) => {
      const v = Number(r.value[1]);
      return { labels: r.metric, value: Number.isNaN(v) ? null : v };
    });
  }
}
