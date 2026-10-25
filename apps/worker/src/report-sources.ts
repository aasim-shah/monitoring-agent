import type { PrismaClient } from '@pcp/database';
import type {
  CoverageItem,
  DatabaseStats,
  DeploymentStats,
  AnalyticsStats,
  HostStats,
  IncidentStats,
  ReportSources,
  ReportWindow,
  Snapshot,
  WebsiteStats,
} from '@pcp/reports';
import { databaseActivity } from '@pcp/reports';
import { domainExpiry } from './domain-expiry.js';
import { kpisFor, type TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';

const DB_PROVIDERS = ['postgres', 'mysql', 'mongodb'];
/** How far before the window's start a health snapshot may be and still count as its baseline. */
const BASELINE_SLACK_MS = 6 * 3_600_000;
/** Google resources with daily KPI values, and how a report names their source. */
const GOOGLE_SOURCE: Record<string, string> = {
  google_ga4_property: 'GA4',
  google_search_console_site: 'Search Console',
  google_play_app: 'Play vitals',
};
const QUERY_TIMEOUT_MS = 10_000;

type Sample = { labels: Record<string, string>; value: number | null };

/**
 * One tenant- and product-scoped instant query (D16): `extra_label=tenant_id` and an
 * `extra_filters` product matcher, as in the api's telemetry query service. Null when telemetry
 * storage is not configured or does not answer.
 */
async function vmInstant(
  base: string | undefined,
  organizationId: string,
  productId: string,
  promql: string,
  at: Date,
): Promise<Sample[] | null> {
  if (!base) return null;
  const params = new URLSearchParams({
    extra_label: `tenant_id=${organizationId}`,
    'extra_filters[]': `{product_id="${productId}"}`,
    query: promql,
    time: String(Math.floor(at.getTime() / 1000)),
    timeout: `${QUERY_TIMEOUT_MS / 1000}s`,
  });
  try {
    const res = await fetch(`${base}/api/v1/query?${params}`, {
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    const body = (await res.json()) as {
      status: string;
      data?: { result: Array<{ metric: Record<string, string>; value: [number, string] }> };
    };
    if (!res.ok || body.status !== 'success' || !body.data) return null;
    return body.data.result.map((r) => {
      const v = Number(r.value[1]);
      return { labels: r.metric, value: Number.isFinite(v) ? v : null };
    });
  } catch {
    return null;
  }
}

/** The same scoping as `vmInstant`, as a range query: one value per `stepSeconds`, null for gaps. */
async function vmRange(
  base: string | undefined,
  organizationId: string,
  productId: string,
  promql: string,
  w: ReportWindow,
  stepSeconds: number,
  keyLabel = 'monitor_id',
): Promise<Map<string, Map<number, number>> | null> {
  if (!base) return null;
  const params = new URLSearchParams({
    extra_label: `tenant_id=${organizationId}`,
    'extra_filters[]': `{product_id="${productId}"}`,
    query: promql,
    start: String(Math.floor(w.start.getTime() / 1000) + stepSeconds),
    end: String(Math.floor(w.end.getTime() / 1000)),
    step: `${stepSeconds}s`,
    timeout: `${QUERY_TIMEOUT_MS / 1000}s`,
  });
  try {
    const res = await fetch(`${base}/api/v1/query_range?${params}`, {
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    const body = (await res.json()) as {
      status: string;
      data?: { result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
    };
    if (!res.ok || body.status !== 'success' || !body.data) return null;
    return new Map(
      body.data.result.map((r) => [
        r.metric[keyLabel] ?? '',
        new Map(
          r.values.map(([t, v]) => [t, Number(v)] as [number, number]).filter(([, v]) => Number.isFinite(v)),
        ),
      ]),
    );
  } catch {
    return null;
  }
}

const byAgent = (rows: Sample[] | null) =>
  new Map((rows ?? []).map((r) => [r.labels.agent_id ?? '', r.value]));

/**
 * The report's data for one product (spec §13.3 D–F): incidents and connections from
 * PostgreSQL, host, log, and website numbers from VictoriaMetrics over the local day. Each
 * source is read once per window; a source without data is `null` and explained in coverage.
 */
export function createReportSources(deps: {
  prisma: PrismaClient;
  vmQueryUrl?: string;
  /** When a host's domain registration expires (ISO); RDAP by default. */
  domainExpiry?: (host: string, at: Date) => Promise<string | null>;
}) {
  const expiry = deps.domainExpiry ?? ((host: string, at: Date) => domainExpiry(host, at));
  return (ctx: TenantContext, productId: string): ReportSources => {
    const memo = new Map<string, Promise<unknown>>();
    const once = <T>(name: string, w: ReportWindow, f: () => Promise<T>): Promise<T> => {
      const key = `${name}:${w.localDate}`;
      if (!memo.has(key)) memo.set(key, f());
      return memo.get(key) as Promise<T>;
    };
    const vm = (promql: string, w: ReportWindow) =>
      vmInstant(deps.vmQueryUrl, ctx.organizationId, productId, promql, w.end);
    const db = <T>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(deps.prisma, ctx, f);

    const incidents = (w: ReportWindow) =>
      once<IncidentStats>('incidents', w, () =>
        db(async (tx) => {
          const inWindow = { gte: w.start, lt: w.end };
          const [opened, resolved, openNow, openCritical] = await Promise.all([
            tx.alertIncident.count({ where: { productId, startedAt: inWindow } }),
            tx.alertIncident.count({ where: { productId, resolvedAt: inWindow } }),
            tx.alertIncident.count({ where: { productId, status: { not: 'resolved' } } }),
            tx.alertIncident.count({
              where: { productId, status: { not: 'resolved' }, severity: 'critical' },
            }),
          ]);
          return { opened, resolved, openNow, openCritical };
        }),
      );

    const hosts = (w: ReportWindow) =>
      once<HostStats[] | null>('hosts', w, async () => {
        const r = `${w.hours}h`;
        const [cpu, cpuMax, memory, disk] = await Promise.all([
          vm(
            `100 * (1 - avg by (agent_id) (avg_over_time(system_cpu_utilization_ratio{state="idle"}[${r}])))`,
            w,
          ),
          vm(
            `100 * max by (agent_id) (max_over_time((1 - avg by (agent_id) (system_cpu_utilization_ratio{state="idle"}))[${r}:5m]))`,
            w,
          ),
          vm(
            `100 * avg by (agent_id) (avg_over_time(system_memory_utilization_ratio{state="used"}[${r}]))`,
            w,
          ),
          vm(`100 * max by (agent_id) (max_over_time(system_filesystem_utilization_ratio[${r}]))`, w),
        ]);
        // CPU every 5 minutes, only to say when the peak happened.
        const cpuSeries = await vmRange(
          deps.vmQueryUrl,
          ctx.organizationId,
          productId,
          '100 * (1 - avg by (agent_id) (avg_over_time(system_cpu_utilization_ratio{state="idle"}[5m])))',
          w,
          300,
          'agent_id',
        );
        const peakAt = (id: string) => {
          let best: [number, number] | null = null;
          for (const [t, v] of cpuSeries?.get(id) ?? []) if (!best || v > best[1]) best = [t, v];
          return best ? new Date(best[0] * 1000).toISOString() : null;
        };
        if (!cpu?.length) return null;
        const names = new Map(
          (
            await db((tx) =>
              tx.agent.findMany({ where: { productId }, select: { id: true, hostname: true } }),
            )
          ).map((a) => [a.id, a.hostname]),
        );
        const [mx, mem, dk] = [byAgent(cpuMax), byAgent(memory), byAgent(disk)];
        return cpu.map((c) => {
          const id = c.labels.agent_id ?? '';
          return {
            hostname: names.get(id) ?? id,
            cpuAvg: c.value,
            cpuMax: mx.get(id) ?? null,
            cpuPeakAt: peakAt(id),
            memoryAvg: mem.get(id) ?? null,
            diskMax: dk.get(id) ?? null,
          };
        });
      });

    const logErrors = (w: ReportWindow) =>
      once('logs', w, async () => {
        const count = (level: string) =>
          vm(`sum(increase_pure({__name__=~"log_lines(_total)?",level="${level}"}[${w.hours}h]))`, w);
        const [errors, warnings] = await Promise.all([count('error'), count('warn')]);
        if (!errors?.length) return null;
        return { errors: Math.round(errors[0]!.value ?? 0), warnings: Math.round(warnings?.[0]?.value ?? 0) };
      });

    const databases = (w: ReportWindow) =>
      once<DatabaseStats[] | null>('databases', w, () =>
        db(async (tx) => {
          const conns = await tx.connection.findMany({
            where: { provider: { in: DB_PROVIDERS }, scopes: { some: { productId } } },
            select: {
              id: true,
              displayName: true,
              provider: true,
              health: { where: { checkedAt: { lt: w.end } }, orderBy: { checkedAt: 'desc' }, take: 1 },
            },
          });
          if (!conns.length) return null;
          const parse = (detail: string | null) => {
            try {
              return detail ? (JSON.parse(detail) as Record<string, unknown>) : null;
            } catch {
              return null;
            }
          };
          return Promise.all(
            conns.map(async (c) => {
              const h = c.health[0];
              // Activity: the last good snapshot before the window's end against the last good one at
              // its start, no more than 6 h earlier (M15b, Review Focus #3).
              const [end, start] = await Promise.all([
                tx.connectionHealth.findFirst({
                  where: { connectionId: c.id, ok: true, checkedAt: { lt: w.end, gt: w.start } },
                  orderBy: { checkedAt: 'desc' },
                }),
                tx.connectionHealth.findFirst({
                  where: {
                    connectionId: c.id,
                    ok: true,
                    checkedAt: { lte: w.start, gte: new Date(w.start.getTime() - BASELINE_SLACK_MS) },
                  },
                  orderBy: { checkedAt: 'desc' },
                }),
              ]);
              return {
                name: c.displayName,
                provider: c.provider,
                status: h ? (h.ok ? 'healthy' : (h.reason ?? 'failing')) : 'no health check yet',
                ok: h ? h.ok : null,
                ...(end
                  ? { activity: databaseActivity(parse(start?.detail ?? null), parse(end.detail)) }
                  : {}),
              };
            }),
          );
        }),
      );

    const websites = (w: ReportWindow) =>
      once<WebsiteStats[] | null>('websites', w, async () => {
        const monitors = await db((tx) =>
          tx.websiteMonitor.findMany({
            where: { productId, status: 'active' },
            select: { id: true, url: true, tlsExpiresAt: true },
          }),
        );
        if (!monitors.length) return null;
        const prev: ReportWindow = {
          ...w,
          start: new Date(w.start.getTime() - w.hours * 3_600_000),
          end: w.start,
        };
        const per = async (promql: string, win: ReportWindow) =>
          byAgent(
            (await vm(promql.replaceAll('$R', `${win.hours}h`), win))?.map((s) => ({
              labels: { agent_id: s.labels.monitor_id ?? '' },
              value: s.value,
            })) ?? null,
          );
        const UP = '100 * avg by (monitor_id) (avg_over_time(website_up[$R]))';
        const AVG = '1000 * avg by (monitor_id) (avg_over_time(website_response_seconds[$R]))';
        const [uptime, avg, p95, failed, prevUptime, prevAvg, hourly] = await Promise.all([
          per(UP, w),
          per(AVG, w),
          per('1000 * max by (monitor_id) (quantile_over_time(0.95, website_response_seconds[$R]))', w),
          per('sum by (monitor_id) (count_le_over_time(website_up[$R], 0))', w),
          per(UP, prev),
          per(AVG, prev),
          vmRange(
            deps.vmQueryUrl,
            ctx.organizationId,
            productId,
            '100 * avg by (monitor_id) (avg_over_time(website_up[1h]))',
            w,
            3600,
          ),
        ]);
        // One block per hour of the local day, oldest first; hours with no checks stay null. The
        // store may align points to whole hours, so each lands in the hour it is closest to the end of.
        const hourOf = (t: number) => Math.round((t - w.start.getTime() / 1000) / 3600) - 1;
        const blocks = (points: Map<number, number> | undefined) => {
          const out: Array<number | null> = Array.from({ length: w.hours }, () => null);
          for (const [t, v] of points ?? []) {
            const i = hourOf(t);
            if (i >= 0 && i < w.hours) out[i] = v;
          }
          return out;
        };
        const domains = await Promise.all(
          monitors.map(async (m) => {
            let host = '';
            try {
              host = new URL(m.url).hostname;
            } catch {
              return null;
            }
            const at = await expiry(host, w.end);
            return at ? Math.floor((Date.parse(at) - w.end.getTime()) / 86_400_000) : null;
          }),
        );
        return monitors.map((m, i) => ({
          url: m.url,
          domainDays: domains[i] ?? null,
          uptimePercent: uptime.get(m.id) ?? null,
          tlsDays: m.tlsExpiresAt
            ? Math.floor((m.tlsExpiresAt.getTime() - w.end.getTime()) / 86_400_000)
            : null,
          avgMs: avg.get(m.id) ?? null,
          p95Ms: p95.get(m.id) ?? null,
          failedChecks: failed.get(m.id) ?? (uptime.has(m.id) ? 0 : null),
          previousUptimePercent: prevUptime.get(m.id) ?? null,
          previousAvgMs: prevAvg.get(m.id) ?? null,
          ...(hourly ? { hourly: blocks(hourly.get(m.id)) } : {}),
        }));
      });

    const deployments = (w: ReportWindow) =>
      once<DeploymentStats | null>('deployments', w, () =>
        db(async (tx) => {
          const scoped = { scopes: { some: { productId } } };
          const sources = await tx.connection.count({
            where: { provider: 'github', status: { notIn: ['disconnected', 'revoked'] }, ...scoped },
          });
          if (!sources) return null;
          const rows = await tx.changeEvent.findMany({
            where: {
              kind: { in: ['deployment', 'deployment_failed'] },
              occurredAt: { gte: w.start, lt: w.end },
              connection: scoped,
            },
            orderBy: { occurredAt: 'desc' },
            take: 100,
            select: { kind: true, title: true, occurredAt: true },
          });
          return {
            deployed: rows.filter((r) => r.kind === 'deployment').length,
            failed: rows.filter((r) => r.kind === 'deployment_failed').length,
            items: rows
              .slice(0, 20)
              .map((r) => ({ kind: r.kind, title: r.title, occurredAt: r.occurredAt.toISOString() })),
          };
        }),
      );

    /**
     * Each scoped Google property, site, or app (M13b): per KPI the latest day at or before the report
     * date that has a value, and the day before it (Search Console and Play publish ~2 days late).
     */
    const analytics = (w: ReportWindow) =>
      once<AnalyticsStats | null>('analytics', w, () =>
        db(async (tx) => {
          const connections = await tx.connection.findMany({
            where: {
              provider: 'google',
              status: { notIn: ['disconnected', 'revoked'] },
              scopes: { some: { productId } },
            },
            include: { scopes: { where: { productId } } },
          });
          if (!connections.length) return null;
          const reportDay = new Date(`${w.localDate}T00:00:00Z`);
          const rows = await tx.metricAggregate.findMany({
            where: {
              connectionId: { in: connections.map((c) => c.id) },
              day: { lte: reportDay, gte: new Date(reportDay.getTime() - 10 * 86_400_000) },
              dimension: '',
            },
            orderBy: { day: 'desc' },
          });
          const iso = (d: Date) => d.toISOString().slice(0, 10);
          // GA4 breakdowns for the report day and the day before: visitors per hour, events by name.
          const breakdowns = await tx.metricAggregate.findMany({
            where: {
              connectionId: { in: connections.map((c) => c.id) },
              resourceType: 'google_ga4_property',
              day: { in: [new Date(reportDay.getTime() - 86_400_000), reportDay] },
              OR: [{ dimension: { startsWith: 'hour:' } }, { dimension: { startsWith: 'event:' } }],
            },
            select: { connectionId: true, externalId: true, dimension: true, day: true, value: true },
          });
          const ga4Extras = (connectionId: string, externalId: string) => {
            const mine = breakdowns.filter(
              (b) => b.connectionId === connectionId && b.externalId === externalId && b.value !== null,
            );
            const today = mine.filter((b) => iso(b.day) === w.localDate);
            const hours = today.filter((b) => b.dimension.startsWith('hour:'));
            const top = hours.sort((a, b) => b.value! - a.value!)[0];
            const yesterday = new Map(
              mine
                .filter((b) => iso(b.day) !== w.localDate && b.dimension.startsWith('event:'))
                .map((b) => [b.dimension, b.value!]),
            );
            return {
              busiestHour: top ? { hour: Number(top.dimension.slice(5)), users: top.value! } : null,
              events: today
                .filter((b) => b.dimension.startsWith('event:'))
                .sort((a, b) => b.value! - a.value!)
                .slice(0, 40)
                .map((b) => ({
                  name: b.dimension.slice(6),
                  count: b.value!,
                  previous: yesterday.get(b.dimension) ?? null,
                })),
            };
          };
          return {
            reportDay: w.localDate,
            resources: connections.flatMap((c) =>
              c.scopes
                .filter((sc) => GOOGLE_SOURCE[sc.resourceType])
                .map((sc) => {
                  const mine = rows.filter(
                    (r) =>
                      r.connectionId === c.id &&
                      r.resourceType === sc.resourceType &&
                      r.externalId === sc.externalId,
                  );
                  const values = kpisFor(sc.resourceType).map((def) => {
                    const days = mine.filter((r) => r.metric === def.metric && r.value !== null);
                    const [latest, before] = days;
                    return {
                      label: def.label,
                      unit: def.unit,
                      value: latest?.value ?? null,
                      day: latest ? iso(latest.day) : null,
                      previous: before?.value ?? null,
                      previousDay: before ? iso(before.day) : null,
                    };
                  });
                  return {
                    name: sc.name,
                    source: GOOGLE_SOURCE[sc.resourceType]!,
                    partial: mine.some((r) => iso(r.day) === w.localDate && r.completeness === 'partial'),
                    values,
                    ...(sc.resourceType === 'google_ga4_property' ? ga4Extras(c.id, sc.externalId) : {}),
                  };
                }),
            ),
            firebaseApps: connections.flatMap((c) =>
              c.scopes.filter((sc) => sc.resourceType === 'google_firebase_app').map((sc) => sc.name),
            ),
          };
        }),
      );

    const coverage = async (w: ReportWindow): Promise<CoverageItem[]> => {
      const [h, l, d, s] = await Promise.all([hosts(w), logErrors(w), databases(w), websites(w)]);
      const telemetry = deps.vmQueryUrl ? null : 'Telemetry storage is not configured';
      const item = (source: string, ok: boolean, reason: string): CoverageItem =>
        ok ? { source, status: 'ok' } : { source, status: 'missing', reason: telemetry ?? reason };
      return [
        { source: 'Incidents', status: 'ok' },
        item('Host metrics', h !== null, 'No agent reported host metrics in this window'),
        item('Log metrics', l !== null, 'No log-derived metrics in this window'),
        d === null
          ? { source: 'Databases', status: 'missing', reason: 'No database connected to this product' }
          : { source: 'Databases', status: 'ok' },
        s === null
          ? { source: 'Website monitors', status: 'missing', reason: 'No verified website monitors' }
          : {
              source: 'Website monitors',
              status: s.some((x) => x.uptimePercent === null) ? 'partial' : 'ok',
            },
      ];
    };

    /** The latest version of each of the 7 earlier days' reports, for the trend lines. */
    const history = (w: ReportWindow): Promise<Snapshot[]> =>
      db(async (tx) => {
        const day = new Date(`${w.localDate}T00:00:00Z`);
        const rows = await tx.generatedReport.findMany({
          where: { productId, localDate: { gte: new Date(day.getTime() - 7 * 86_400_000), lt: day } },
          orderBy: [{ localDate: 'desc' }, { version: 'desc' }, { createdAt: 'desc' }],
          select: { localDate: true, snapshot: true },
          take: 100,
        });
        const seen = new Set<string>();
        return rows.flatMap((r) => {
          const key = r.localDate.toISOString().slice(0, 10);
          if (seen.has(key)) return [];
          seen.add(key);
          return [r.snapshot as unknown as Snapshot];
        });
      });

    return { incidents, hosts, logErrors, databases, websites, deployments, analytics, coverage, history };
  };
}
