import type { PrismaClient } from '@pcp/database';
import type {
  CoverageItem,
  DatabaseStats,
  DeploymentStats,
  HostStats,
  IncidentStats,
  ReportSources,
  ReportWindow,
  WebsiteStats,
} from '@pcp/reports';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';

const DB_PROVIDERS = ['postgres', 'mysql', 'mongodb'];
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

const byAgent = (rows: Sample[] | null) =>
  new Map((rows ?? []).map((r) => [r.labels.agent_id ?? '', r.value]));

/**
 * The report's data for one product (spec §13.3 D–F): incidents and connections from
 * PostgreSQL, host, log, and website numbers from VictoriaMetrics over the local day. Each
 * source is read once per window; a source without data is `null` and explained in coverage.
 */
export function createReportSources(deps: { prisma: PrismaClient; vmQueryUrl?: string }) {
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
              displayName: true,
              provider: true,
              health: { where: { checkedAt: { lt: w.end } }, orderBy: { checkedAt: 'desc' }, take: 1 },
            },
          });
          if (!conns.length) return null;
          return conns.map((c) => {
            const h = c.health[0];
            return {
              name: c.displayName,
              provider: c.provider,
              status: h ? (h.ok ? 'healthy' : (h.reason ?? 'failing')) : 'no health check yet',
              ok: h ? h.ok : null,
            };
          });
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
        const uptime = byAgent(
          (await vm(`100 * avg by (monitor_id) (avg_over_time(website_up[${w.hours}h]))`, w))?.map((s) => ({
            labels: { agent_id: s.labels.monitor_id ?? '' },
            value: s.value,
          })) ?? null,
        );
        return monitors.map((m) => ({
          url: m.url,
          uptimePercent: uptime.get(m.id) ?? null,
          tlsDays: m.tlsExpiresAt
            ? Math.floor((m.tlsExpiresAt.getTime() - w.end.getTime()) / 86_400_000)
            : null,
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

    return { incidents, hosts, logErrors, databases, websites, deployments, coverage };
  };
}
