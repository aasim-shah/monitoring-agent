import { defineTool, ToolNotFound, type Tool } from '@pcp/ai-orchestrator';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { z } from 'zod/v4';
import { ApiException } from '../../common/errors.js';
import type { AssetsService } from '../assets/assets.service.js';
import { FLEET_QUERIES } from '../telemetry/host-metrics.js';
import type { TelemetryQueryService } from '../telemetry/query.service.js';

/** What every tool needs; the product is the conversation's, never chosen by the model. */
export interface AiDeps {
  prisma: PrismaClient;
  assets: AssetsService;
  telemetry: TelemetryQueryService;
  productId: string;
  orgId: string;
  now(): Date;
}

const RANGE = z.enum(['1h', '24h', '7d']).default('24h').describe('Look-back window');
const RANGE_SECONDS = { '1h': 3600, '24h': 86400, '7d': 7 * 86400 } as const;
const UUID = z.string().uuid();
const round = (v: number | null | undefined) =>
  v === null || v === undefined ? null : Math.round(v * 10) / 10;
const base = (d: AiDeps) => `/orgs/${d.orgId}/products/${d.productId}`;

/** Out-of-scope or unknown IDs look the same to the model: not found (TC-14-01). */
async function scoped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiException && err.getStatus() === 404) throw new ToolNotFound();
    throw err;
  }
}

const unavailable = (name: string, description: string, gap: string): Tool =>
  defineTool<Record<string, never>, AiDeps>({
    name,
    description: `${description} (no source is connected for this yet)`,
    permission: 'telemetry.query',
    input: z.object({}),
    run: async () => ({ data: { available: false }, gaps: [gap] }),
  });

async function hostNames(ctx: TenantContext, d: AiDeps): Promise<Map<string, string>> {
  const agents = await withTenant(d.prisma, ctx, (tx) =>
    tx.agent.findMany({ where: { productId: d.productId }, select: { id: true, hostname: true } }),
  );
  return new Map(agents.map((a) => [a.id, a.hostname]));
}

/** min / avg / max over the window and the latest value, per host (no raw series to the model). */
async function hostStats(
  ctx: TenantContext,
  d: AiDeps,
  metric: keyof typeof FLEET_QUERIES,
  range: keyof typeof RANGE_SECONDS,
  at?: Date,
) {
  const expr = FLEET_QUERIES[metric];
  const scope = { productId: d.productId };
  const [min, avg, max, latest] = await Promise.all(
    ['min_over_time', 'avg_over_time', 'max_over_time']
      .map((fn) => d.telemetry.instant(ctx, `${fn}((${expr})[${range}:5m])`, scope, at))
      .concat([d.telemetry.instant(ctx, expr, scope, at)]),
  );
  const by = (rows: typeof min) => new Map(rows!.map((r) => [r.labels.agent_id ?? '', r.value]));
  const [mn, av, mx, la] = [by(min), by(avg), by(max), by(latest)];
  return [...new Set([...av.keys(), ...la.keys()])].map((agentId) => ({
    agentId,
    min: round(mn.get(agentId)),
    avg: round(av.get(agentId)),
    max: round(mx.get(agentId)),
    latest: round(la.get(agentId)),
  }));
}

export const AI_TOOLS: Tool[] = [
  defineTool<Record<string, never>, AiDeps>({
    name: 'listProducts',
    description: 'Products the asking member can see in this organization.',
    permission: 'product.view',
    input: z.object({}),
    run: async (ctx, _i, d) => {
      const rows = await withTenant(d.prisma, ctx, (tx) =>
        tx.product.findMany({
          where: ctx.productIds === 'all' ? {} : { id: { in: ctx.productIds } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      );
      return { data: { products: rows, current: d.productId } };
    },
  }),
  defineTool<{ type?: string }, AiDeps>({
    name: 'listAssets',
    description:
      'Assets of this product (hosts, services, databases, websites) with lifecycle and last seen time.',
    permission: 'asset.view',
    input: z.object({
      type: z
        .enum(['host', 'service', 'database', 'website', 'domain', 'repository', 'worker', 'external'])
        .optional(),
    }),
    run: async (ctx, input, d) => {
      const rows = await d.assets.list(ctx, d.productId, { type: input.type });
      return {
        data: {
          assets: rows.slice(0, 200).map((a) => ({
            id: a.id,
            name: a.name,
            type: a.assetType,
            lifecycle: a.lifecycle,
            lastSeenAt: a.lastSeenAt,
          })),
          total: rows.length,
        },
        sources: [{ label: 'Assets', href: `${base(d)}/assets` }],
      };
    },
  }),
  defineTool<{ assetId: string }, AiDeps>({
    name: 'getAssetDetails',
    description: 'One asset: identity, type, lifecycle, source, and freshness.',
    permission: 'asset.view',
    input: z.object({ assetId: UUID }),
    run: async (ctx, input, d) => {
      const a = await scoped(() => d.assets.get(ctx, input.assetId));
      if (!a.productIds.includes(d.productId)) throw new ToolNotFound();
      return {
        data: {
          id: a.id,
          name: a.name,
          type: a.assetType,
          lifecycle: a.lifecycle,
          source: a.source,
          lastSeenAt: a.lastSeenAt,
        },
        sources: [{ label: `Asset ${a.name}`, href: `${base(d)}/assets/${a.id}` }],
      };
    },
  }),
  defineTool<{ assetId: string }, AiDeps>({
    name: 'getDependencies',
    description: 'Upstream and downstream relationships of an asset with type, verification, and confidence.',
    permission: 'asset.view',
    input: z.object({ assetId: UUID }),
    run: async (ctx, input, d) => {
      const rels = await scoped(() => d.assets.relationships(ctx, input.assetId));
      return {
        data: {
          relationships: (rels as Array<Record<string, unknown>>).slice(0, 100).map((r) => ({
            type: r.type,
            verification: r.verification,
            confidence: r.confidence,
            source: (r.source as { name?: string } | undefined)?.name,
            target: (r.target as { name?: string } | undefined)?.name,
          })),
        },
      };
    },
  }),
  defineTool<{ assetId: string }, AiDeps>({
    name: 'getPotentialImpact',
    description: 'Blast radius of an asset: dependents with impact class confirmed, potential, or unknown.',
    permission: 'asset.view',
    input: z.object({ assetId: UUID }),
    run: async (ctx, input, d) => {
      const rows = await scoped(() => d.assets.impact(ctx, input.assetId, 4));
      return {
        data: {
          impacted: rows
            .slice(0, 50)
            .map((r) => ({ name: r.name, type: r.assetType, impact: r.impact, distance: r.distance })),
        },
        sources: [{ label: 'Impact on the asset page', href: `${base(d)}/assets/${input.assetId}` }],
      };
    },
  }),
  defineTool<{ range: keyof typeof RANGE_SECONDS }, AiDeps>({
    name: 'getInfrastructureMetrics',
    description:
      'CPU, memory, and disk use (percent) per host of this product: min, average, max over the window and the latest value.',
    permission: 'telemetry.query',
    input: z.object({ range: RANGE }),
    run: async (ctx, input, d) => {
      const names = await hostNames(ctx, d);
      const [cpu, memory, disk] = await Promise.all(
        (['cpu', 'memory', 'disk'] as const).map((m) => hostStats(ctx, d, m, input.range)),
      );
      const hosts = [...new Set([...cpu!, ...memory!, ...disk!].map((h) => h.agentId))].map((agentId) => ({
        host: names.get(agentId) ?? agentId,
        cpuPercent: cpu!.find((h) => h.agentId === agentId) ?? null,
        memoryPercent: memory!.find((h) => h.agentId === agentId) ?? null,
        diskPercent: disk!.find((h) => h.agentId === agentId) ?? null,
      }));
      return {
        data: { range: input.range, hosts },
        gaps: hosts.length ? [] : ['Host metrics: no agent has reported for this product'],
        sources: [{ label: 'Infrastructure', href: `${base(d)}/infrastructure` }],
      };
    },
  }),
  defineTool<{ range: keyof typeof RANGE_SECONDS }, AiDeps>({
    name: 'getApplicationErrors',
    description: 'Error log lines per service and host (counted on the server from log files; no log text).',
    permission: 'telemetry.query',
    input: z.object({ range: RANGE }),
    run: async (ctx, input, d) => {
      const names = await hostNames(ctx, d);
      const rows = await d.telemetry.instant(
        ctx,
        `sum by (agent_id, service, level) (increase_pure({__name__=~"log_lines(_total)?",level=~"error|warn"}[${input.range}]))`,
        { productId: d.productId },
      );
      return {
        data: {
          range: input.range,
          counts: rows.map((r) => ({
            host: names.get(r.labels.agent_id ?? '') ?? r.labels.agent_id,
            service: r.labels.service,
            level: r.labels.level,
            lines: round(r.value),
          })),
        },
        gaps: rows.length ? [] : ['Log counts: no monitored service writes log files on this product'],
      };
    },
  }),
  defineTool<Record<string, never>, AiDeps>({
    name: 'getConnectionHealth',
    description:
      'Integrations and database connections of this product: status, reason, and latest health check.',
    permission: 'connection.view',
    input: z.object({}),
    run: async (ctx, _i, d) => {
      const rows = await withTenant(d.prisma, ctx, (tx) =>
        tx.connection.findMany({
          where: { scopes: { some: { productId: d.productId } } },
          select: {
            displayName: true,
            provider: true,
            status: true,
            statusReason: true,
            health: { orderBy: { checkedAt: 'desc' }, take: 1, select: { ok: true, checkedAt: true } },
          },
        }),
      );
      return {
        data: {
          connections: rows.map((c) => ({
            name: c.displayName,
            provider: c.provider,
            status: c.status,
            reason: c.statusReason,
            lastCheck: c.health[0] ?? null,
          })),
        },
      };
    },
  }),
  defineTool<Record<string, never>, AiDeps>({
    name: 'getDatabaseHealth',
    description:
      'Latest health summary of each database connection: connections in use, sizes, replication lag.',
    permission: 'telemetry.query',
    input: z.object({}),
    run: async (ctx, _i, d) => {
      const rows = await withTenant(d.prisma, ctx, (tx) =>
        tx.connection.findMany({
          where: {
            provider: { in: ['postgres', 'mysql', 'mongodb'] },
            scopes: { some: { productId: d.productId } },
          },
          select: {
            displayName: true,
            provider: true,
            status: true,
            health: {
              orderBy: { checkedAt: 'desc' },
              take: 1,
              select: { ok: true, checkedAt: true, detail: true },
            },
          },
        }),
      );
      return {
        data: {
          databases: rows.map((c) => {
            let h: Record<string, unknown> = {};
            try {
              h = c.health[0]?.ok ? (JSON.parse(c.health[0].detail ?? '{}') as Record<string, unknown>) : {};
            } catch {
              h = {};
            }
            return {
              name: c.displayName,
              engine: c.provider,
              status: c.status,
              checkedAt: c.health[0]?.checkedAt ?? null,
              connections: h.connections ?? null,
              maxConnections: h.maxConnections ?? null,
              replicationLagSeconds: h.replicationLagSeconds ?? null,
            };
          }),
        },
        gaps: rows.length ? [] : ['Databases: none connected for this product'],
        sources: [{ label: 'Databases', href: `${base(d)}/databases` }],
      };
    },
  }),
  defineTool<{ status: 'active' | 'all' }, AiDeps>({
    name: 'getIncidents',
    description: 'Incidents of this product with severity, status, start time, summary, and timeline size.',
    permission: 'incident.view',
    input: z.object({ status: z.enum(['active', 'all']).default('active') }),
    run: async (ctx, input, d) => {
      const rows = await withTenant(d.prisma, ctx, (tx) =>
        tx.alertIncident.findMany({
          where: {
            productId: d.productId,
            ...(input.status === 'active' ? { status: { in: ['open', 'acknowledged'] } } : {}),
          },
          orderBy: { startedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            title: true,
            severity: true,
            status: true,
            startedAt: true,
            resolvedAt: true,
            summary: true,
            _count: { select: { events: true } },
          },
        }),
      );
      return {
        data: {
          incidents: rows.map((i) => ({
            id: i.id,
            title: i.title,
            severity: i.severity,
            status: i.status,
            startedAt: i.startedAt,
            resolvedAt: i.resolvedAt,
            summary: i.summary,
            timelineEvents: i._count.events,
          })),
        },
        sources: rows
          .slice(0, 5)
          .map((i) => ({ label: `Incident: ${i.title}`, href: `${base(d)}/incidents/${i.id}` })),
      };
    },
  }),
  defineTool<{ metric: 'cpu' | 'memory' | 'disk'; window: '1h' | '24h' | '7d' }, AiDeps>({
    name: 'comparePeriods',
    description:
      'Deterministic comparison of a host metric (average percent) between the last window and the window before it, per host.',
    permission: 'telemetry.query',
    input: z.object({
      metric: z.enum(['cpu', 'memory', 'disk']),
      window: z.enum(['1h', '24h', '7d']).default('24h'),
    }),
    run: async (ctx, input, d) => {
      const names = await hostNames(ctx, d);
      const now = d.now();
      const before = new Date(now.getTime() - RANGE_SECONDS[input.window] * 1000);
      const [current, previous] = await Promise.all([
        hostStats(ctx, d, input.metric, input.window, now),
        hostStats(ctx, d, input.metric, input.window, before),
      ]);
      return {
        data: {
          metric: `${input.metric} percent`,
          window: input.window,
          currentPeriod: { from: before.toISOString(), to: now.toISOString() },
          hosts: current.map((c) => {
            const p = previous.find((x) => x.agentId === c.agentId);
            const delta = c.avg !== null && p?.avg != null ? round(c.avg - p.avg) : null;
            return {
              host: names.get(c.agentId) ?? c.agentId,
              currentAvg: c.avg,
              previousAvg: p?.avg ?? null,
              change: delta,
            };
          }),
        },
      };
    },
  }),
  defineTool<{ range: keyof typeof RANGE_SECONDS }, AiDeps>({
    name: 'getWebsiteAvailability',
    description:
      'Monitored websites and APIs of this product: verification state, last probe (up, status code, response time), consecutive failures, TLS expiry, and uptime percent over the window.',
    permission: 'telemetry.query',
    input: z.object({ range: RANGE }),
    run: async (ctx, input, d) => {
      const monitors = await withTenant(d.prisma, ctx, (tx) =>
        tx.websiteMonitor.findMany({
          where: { productId: d.productId },
          orderBy: { createdAt: 'asc' },
          take: 50,
        }),
      );
      const gaps: string[] = [];
      let uptime = new Map<string, number | null>();
      if (monitors.some((m) => m.status === 'active')) {
        try {
          const rows = await d.telemetry.instant(
            ctx,
            `100 * avg by (monitor_id) (avg_over_time(website_up[${input.range}]))`,
            { productId: d.productId },
          );
          uptime = new Map(rows.map((r) => [r.labels.monitor_id ?? '', round(r.value)]));
        } catch {
          gaps.push('Website uptime history: telemetry storage unavailable');
        }
      }
      const now = d.now().getTime();
      return {
        data: {
          range: input.range,
          monitors: monitors.map((m) => ({
            url: m.url,
            status: m.status,
            pausedReason: m.pausedReason,
            up: m.lastUp,
            statusCode: m.lastStatusCode,
            responseMs: m.lastTotalMs,
            error: m.lastError,
            consecutiveFailures: m.consecutiveFailures,
            lastCheckedAt: m.lastCheckedAt,
            tlsExpiresInDays: m.tlsExpiresAt
              ? Math.floor((m.tlsExpiresAt.getTime() - now) / 86400_000)
              : null,
            uptimePercent: uptime.get(m.id) ?? null,
          })),
        },
        gaps: monitors.length ? gaps : ['Website availability: no websites are monitored for this product'],
        sources: [{ label: 'Websites & APIs', href: `${base(d)}/websites` }],
      };
    },
  }),
  unavailable('getAnalyticsReport', 'GA4 and Firebase product analytics', 'Analytics: source not connected'),
  unavailable('getAdPerformance', 'Ads spend, clicks, conversions', 'Ads: source not connected'),
  unavailable('getDeployments', 'Deployments and code changes', 'Deployments: source not connected'),
  unavailable(
    'getApplicationMetrics',
    'Request rate, errors, and latency of applications',
    'Application traces and request metrics: not instrumented',
  ),
];
