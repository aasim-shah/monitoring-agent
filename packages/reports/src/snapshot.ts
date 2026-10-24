import { DAILY_SECTIONS, type SectionKey } from './templates/daily.js';
import { previousWindow, type ReportWindow } from './window.js';

export interface IncidentStats {
  opened: number;
  resolved: number;
  openNow: number;
  openCritical: number;
}
export interface HostStats {
  hostname: string;
  cpuAvg: number | null;
  cpuMax: number | null;
  memoryAvg: number | null;
  diskMax: number | null;
}
export interface DatabaseStats {
  name: string;
  provider: string;
  status: string;
  ok: boolean | null;
  /** New records and growth over the window (M15b). */
  activity?: DatabaseActivity;
}
export interface WebsiteStats {
  url: string;
  uptimePercent: number | null;
  tlsDays: number | null;
  /** Response time over the window and failed checks (M15b). */
  avgMs?: number | null;
  p95Ms?: number | null;
  failedChecks?: number | null;
  /** The same figures for the 24 h before (trend). */
  previousUptimePercent?: number | null;
  previousAvgMs?: number | null;
}
/** The report day's values per Google property, site, or app (M13b); null values stay null. */
export interface AnalyticsStats {
  /** The report's local date; values from another day say which (M15b). */
  reportDay?: string;
  resources: Array<{
    name: string;
    source: string;
    /** The provider is still processing that day. */
    partial: boolean;
    values: Array<{
      label: string;
      value: number | null;
      unit: string;
      /** The latest published day the value is from (Search Console and Play lag 2 days). */
      day?: string | null;
      previous?: number | null;
      previousDay?: string | null;
    }>;
  }>;
  /** Scoped Firebase apps (names; their crash data needs BigQuery exports). */
  firebaseApps?: string[];
}

import type { DatabaseActivity } from './activity.js';

export interface DeploymentStats {
  deployed: number;
  failed: number;
  /** Newest first, at most 20. */
  items: Array<{ kind: string; title: string; occurredAt: string }>;
}
export interface CoverageItem {
  source: string;
  status: 'ok' | 'partial' | 'missing';
  reason?: string;
}

/** Where a report's numbers come from; `null` means the source has no data (never zero, BR-15-05). */
export interface ReportSources {
  incidents(w: ReportWindow): Promise<IncidentStats>;
  hosts(w: ReportWindow): Promise<HostStats[] | null>;
  logErrors(w: ReportWindow): Promise<{ errors: number; warnings: number } | null>;
  databases(w: ReportWindow): Promise<DatabaseStats[] | null>;
  websites(w: ReportWindow): Promise<WebsiteStats[] | null>;
  /** Null when no deployment source (GitHub) is connected (M7). */
  deployments(w: ReportWindow): Promise<DeploymentStats | null>;
  /** null when no Google connection exists for the product. */
  analytics(w: ReportWindow): Promise<AnalyticsStats | null>;
  coverage(w: ReportWindow): Promise<CoverageItem[]>;
}

export interface Section {
  id: string;
  key: SectionKey;
  title: string;
  status: 'ok' | 'missing';
  data: unknown;
  reason?: string;
}
export interface Anomaly {
  metric: string;
  previous: number;
  current: number;
  changePercent: number;
}
export interface Snapshot {
  window: { timezone: string; localDate: string; start: string; end: string; hours: number };
  sections: Section[];
  anomalies: Anomaly[];
  actions: string[];
  coverage: CoverageItem[];
}

/** Sources that have no connector yet; listed, never zero. */
const NOT_CONNECTED: Partial<Record<SectionKey, { source: string; reason: string }>> = {
  analytics: { source: 'User analytics', reason: 'Google Analytics not connected' },
  ads: { source: 'Advertising', reason: 'No ad platform connected' },
  deployments: { source: 'Deployments', reason: 'No deployment source connected (GitHub, M7)' },
};

const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
const ms = (v: number | null) => (v === null ? null : Math.round(v));

/** A URL without its query string or fragment: tokens never reach a report or the LLM (BR-15-02). */
function bareUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0]!;
  }
}

const mean = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

/** |Δ| ≥ 50 % against the previous day, and the current value above a floor. */
function anomaly(metric: string, previous: number | null, current: number | null, floor: number) {
  if (previous === null || current === null || previous <= 0 || current < floor) return null;
  const change = ((current - previous) / previous) * 100;
  return Math.abs(change) >= 50 ? { metric, previous, current, changePercent: r1(change)! } : null;
}

function suggestedActions(
  incidents: IncidentStats,
  hosts: HostStats[] | null,
  databases: DatabaseStats[] | null,
  websites: WebsiteStats[] | null,
): string[] {
  const actions: string[] = [];
  if (incidents.openCritical > 0)
    actions.push(
      `Resolve ${incidents.openCritical} open critical incident${incidents.openCritical === 1 ? '' : 's'}.`,
    );
  for (const h of hosts ?? [])
    if (h.diskMax !== null && h.diskMax >= 85)
      actions.push(`Free space or grow the disk on ${h.hostname} (${h.diskMax.toFixed(1)} % used).`);
  for (const d of databases ?? []) if (d.ok === false) actions.push(`Check database ${d.name}: ${d.status}.`);
  for (const w of websites ?? []) {
    if (w.uptimePercent !== null && w.uptimePercent < 99)
      actions.push(`Investigate ${w.url}: uptime ${w.uptimePercent.toFixed(1)} %.`);
    if (w.tlsDays !== null && w.tlsDays <= 14)
      actions.push(`Renew the certificate for ${w.url} (${w.tlsDays} days left).`);
  }
  return actions;
}

/**
 * The deterministic part of a daily report (spec §13.3, BR-15-01): every number the report and
 * its narrative may use, rounded to one decimal, with missing sources listed and never zero.
 */
export async function buildSnapshot(sources: ReportSources, w: ReportWindow): Promise<Snapshot> {
  const prev = previousWindow(w);
  const [
    incidents,
    prevIncidents,
    rawHosts,
    prevHosts,
    logs,
    prevLogs,
    databases,
    rawSites,
    coverage,
    deployments,
    analytics,
  ] = await Promise.all([
    sources.incidents(w),
    sources.incidents(prev),
    sources.hosts(w),
    sources.hosts(prev),
    sources.logErrors(w),
    sources.logErrors(prev),
    sources.databases(w),
    sources.websites(w),
    sources.coverage(w),
    sources.deployments(w),
    sources.analytics(w),
  ]);
  const hosts =
    rawHosts?.map((h) => ({
      hostname: h.hostname,
      cpuAvg: r1(h.cpuAvg),
      cpuMax: r1(h.cpuMax),
      memoryAvg: r1(h.memoryAvg),
      diskMax: r1(h.diskMax),
    })) ?? null;
  const websites =
    rawSites?.map((s) => ({
      url: bareUrl(s.url),
      uptimePercent: r1(s.uptimePercent),
      tlsDays: s.tlsDays === null ? null : Math.floor(s.tlsDays),
      ...(s.avgMs !== undefined ? { avgMs: ms(s.avgMs) } : {}),
      ...(s.p95Ms !== undefined ? { p95Ms: ms(s.p95Ms) } : {}),
      ...(s.failedChecks !== undefined ? { failedChecks: s.failedChecks } : {}),
      ...(s.previousUptimePercent !== undefined ? { previousUptimePercent: r1(s.previousUptimePercent) } : {}),
      ...(s.previousAvgMs !== undefined ? { previousAvgMs: ms(s.previousAvgMs) } : {}),
    })) ?? null;
  const cpu = mean(hosts?.map((h) => h.cpuAvg) ?? []);
  const anomalies = [
    anomaly('Average CPU', mean(prevHosts?.map((h) => r1(h.cpuAvg)) ?? []), cpu, 20),
    anomaly('Log errors', prevLogs?.errors ?? null, logs?.errors ?? null, 10),
    anomaly('Incidents opened', prevIncidents.opened, incidents.opened, 10),
  ].filter((a): a is Anomaly => a !== null);
  const actions = suggestedActions(incidents, hosts, databases, websites);
  const allCoverage: CoverageItem[] = [
    ...coverage,
    ...Object.entries(NOT_CONNECTED)
      .filter(([key]) => !(key === 'deployments' && deployments) && !(key === 'analytics' && analytics))
      .map(([, n]) => ({ source: n!.source, status: 'missing' as const, reason: n!.reason })),
  ];

  const data: Record<SectionKey, { data: unknown } | { missing: string }> = {
    summary: {
      data: {
        localDate: w.localDate,
        windowHours: w.hours,
        openIncidents: incidents.openNow,
        incidentsOpened: incidents.opened,
        hosts: hosts?.length ?? null,
        averageCpu: cpu,
        logErrors: logs?.errors ?? null,
        websitesBelow99: websites ? websites.filter((s) => (s.uptimePercent ?? 100) < 99).length : null,
      },
    },
    health: { data: incidents },
    infrastructure: hosts?.length ? { data: { hosts } } : { missing: 'No host metrics in this window' },
    application: logs
      ? { data: logs }
      : { missing: 'No log-derived metrics (turn on log collection on an agent)' },
    analytics: analytics
      ? analytics.resources.length
        ? { data: analytics }
        : { missing: 'Google is connected but no property, site, or app is scoped to this product' }
      : { missing: NOT_CONNECTED.analytics!.reason },
    databases: databases?.length ? { data: { databases } } : { missing: 'No database connected' },
    ads: { missing: NOT_CONNECTED.ads!.reason },
    deployments: deployments ? { data: deployments } : { missing: NOT_CONNECTED.deployments!.reason },
    availability: websites?.length ? { data: { websites } } : { missing: 'No website monitors' },
    anomalies: { data: anomalies },
    actions: { data: actions },
    coverage: { data: allCoverage },
  };

  return {
    window: {
      timezone: w.timezone,
      localDate: w.localDate,
      start: w.start.toISOString(),
      end: w.end.toISOString(),
      hours: w.hours,
    },
    sections: DAILY_SECTIONS.map((s) => {
      const d = data[s.key];
      return 'missing' in d
        ? { id: s.id, key: s.key, title: s.title, status: 'missing' as const, data: null, reason: d.missing }
        : { id: s.id, key: s.key, title: s.title, status: 'ok' as const, data: d.data };
    }),
    anomalies,
    actions,
    coverage: allCoverage,
  };
}
