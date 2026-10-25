import type {
  AnalyticsStats,
  DatabaseStats,
  DeploymentStats,
  HostStats,
  IncidentStats,
  Section,
  Snapshot,
  WebsiteStats,
} from './snapshot.js';

/**
 * The plain reading of a report (web view and email share it): one status, a short summary, up to
 * four headline numbers with trend lines, one card per server, website, Google property, and
 * database, and the few things worth a look. Every figure comes from the snapshot.
 */
export type Tone = 'good' | 'watch' | 'attention' | 'neutral';

export interface Change {
  /** "▲ 29%", "▼ 25%", "No change", or "New". */
  text: string;
  /** null when the direction is neither good nor bad. */
  good: boolean | null;
  /** "vs Fri", or empty when the earlier day is unknown. */
  against: string;
}
export interface Kpi {
  key: string;
  label: string;
  display: string;
  change: Change | null;
  /** Oldest first, ending with this report's value. */
  series: Array<number | null>;
  note?: string;
}
export interface Bar {
  label: string;
  percent: number | null;
  detail: string;
}
export interface Card {
  name: string;
  subtitle: string;
  tone: Tone;
  label: string;
  rows: Array<[string, string]>;
}
export interface HostCard extends Card {
  bars: Bar[];
}
export interface WebsiteCard extends Card {
  hourly: Array<number | null>;
}
export interface AnalyticsCard extends Card {
  compare: {
    label: string;
    previous: number;
    current: number;
    previousLabel: string;
    currentLabel: string;
  } | null;
}
export interface WatchItem {
  title: string;
  text: string;
  tone: 'watch' | 'attention';
}
export interface Digest {
  status: { tone: Exclude<Tone, 'neutral'>; label: string };
  summary: string;
  kpis: Kpi[];
  hosts: HostCard[];
  websites: WebsiteCard[];
  analytics: AnalyticsCard[];
  databases: Card[];
  activity: Card[];
  watch: WatchItem[];
  quiet: string[];
  notConnected: string[];
}

/** Moves smaller than this are "steady"; drops at least this big with real volume are worth a look. */
const MOVE = 20;
/** A count must reach this on one of the two days before its change counts. */
const VOLUME = 20;

const data = <T>(s: Snapshot, key: Section['key']): T | null =>
  (s.sections.find((x) => x.key === key && x.status === 'ok')?.data as T | undefined) ?? null;

const count = (v: number) => Math.round(v).toLocaleString('en-US');
const whole = (v: number) => `${Math.round(v)}%`;
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const weekday = (day: string | null | undefined) =>
  day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }) : '';
const shortDate = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

type Value = AnalyticsStats['resources'][number]['values'][number];
const lowerIsBetter = (label: string, source: string) =>
  label === 'Average position' || (source === 'Play vitals' && label !== 'Daily users (Play vitals)');

function formatValue(v: number, unit: string): string {
  if (unit === 'ratio') return `${Math.round(v * 1000) / 10}%`;
  if (unit === 'percent') return `${Math.round(v * 10) / 10}%`;
  if (unit === 'position') return String(Math.round(v * 10) / 10);
  return count(v);
}

/** The change from `previous` to `current`, or null when either is missing. */
export function change(
  current: number | null | undefined,
  previous: number | null | undefined,
  opts: { lowerIsBetter?: boolean; previousDay?: string | null } = {},
): Change | null {
  if (current == null || previous == null) return null;
  const against = opts.previousDay ? `vs ${weekday(opts.previousDay)}` : '';
  if (previous === 0)
    return current === 0
      ? { text: 'No change', good: null, against }
      : { text: 'New', good: !opts.lowerIsBetter, against };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: 'No change', good: null, against };
  return {
    text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`,
    good: pct > 0 !== (opts.lowerIsBetter ?? false),
    against,
  };
}

/** The values a later report draws its 7-day lines from, keyed like `Kpi.key`. */
export function metricValues(s: Snapshot): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const incidents = data<IncidentStats>(s, 'health');
  if (incidents) {
    out['incidents.opened'] = incidents.opened;
    out['incidents.open'] = incidents.openNow;
  }
  for (const h of data<{ hosts: HostStats[] }>(s, 'infrastructure')?.hosts ?? []) {
    out[`host:${h.hostname}:cpu`] = h.cpuAvg;
    out[`host:${h.hostname}:memory`] = h.memoryAvg;
    out[`host:${h.hostname}:disk`] = h.diskMax;
  }
  for (const w of data<{ websites: WebsiteStats[] }>(s, 'availability')?.websites ?? []) {
    out[`web:${w.url}:uptime`] = w.uptimePercent;
    if (w.avgMs != null) out[`web:${w.url}:ms`] = w.avgMs;
  }
  for (const r of data<AnalyticsStats>(s, 'analytics')?.resources ?? [])
    for (const v of r.values) out[`ga:${r.name}:${v.label}`] = v.value;
  for (const d of data<{ databases: DatabaseStats[] }>(s, 'databases')?.databases ?? [])
    if (d.activity?.rowsAdded != null) out[`db:${d.name}:rows`] = d.activity.rowsAdded;
  const logs = data<{ errors: number }>(s, 'application');
  if (logs) out['logs.errors'] = logs.errors;
  return out;
}

/** The AI summary without its `[S3]` citations, which only the validator needs. */
export const plainNarrative = (text: string) =>
  text
    .replace(/\s*\[S\d+(?:\s*,\s*S\d+)*\]/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();

function series(s: Snapshot, key: string, today: number | null): Array<number | null> {
  return [...(s.history ?? []).map((h) => h.values[key] ?? null), today];
}

function isQuiet(r: AnalyticsStats['resources'][number]): boolean {
  const counts = r.values.filter((v) => v.unit === 'count');
  return counts.length > 0 && counts.every((v) => !v.value && !v.previous);
}

/** The analytics value a card compares and a headline number uses, per kind of source. */
const PRIMARY: Record<string, string[]> = {
  GA4: ['Active users', 'Views'],
  'Search Console': ['Search impressions', 'Search clicks'],
  'Play vitals': ['Daily users (Play vitals)'],
};
const KPI_LABEL: Record<string, string> = {
  'Active users': 'Visitors',
  Views: 'Page views',
  'Search impressions': 'Shown on Google',
  'Search clicks': 'Clicks from Google',
  'Daily users (Play vitals)': 'App users',
};

/** A drop worth a look: a count down by MOVE % with volume, or a lower-is-better rate up by MOVE %. */
function worsened(v: Value, source: string): boolean {
  if (v.value == null || v.previous == null || v.previous === 0) return false;
  const pct = ((v.value - v.previous) / v.previous) * 100;
  if (lowerIsBetter(v.label, source)) return v.unit === 'ratio' ? pct >= MOVE && v.value >= 0.01 : false;
  return v.unit === 'count' && pct <= -MOVE && Math.max(v.value, v.previous) >= VOLUME;
}

function analyticsCards(
  a: AnalyticsStats | null,
  watch: WatchItem[],
): { cards: AnalyticsCard[]; quiet: string[] } {
  const cards: AnalyticsCard[] = [];
  const quiet: string[] = [];
  for (const r of a?.resources ?? []) {
    if (isQuiet(r)) {
      quiet.push(r.name);
      continue;
    }
    const primary = (PRIMARY[r.source] ?? [])
      .map((label) => r.values.find((v) => v.label === label && v.value != null))
      .find(Boolean);
    const lagged = r.values.find((v) => v.day && a?.reportDay && v.day !== a.reportDay)?.day;
    const worst = r.values.filter((v) => worsened(v, r.source))[0];
    const position = r.values.find((v) => v.label === 'Average position');
    if (worst) {
      const lower = lowerIsBetter(worst.label, r.source);
      const positionNote =
        position?.value != null && position.previous != null && position.value > position.previous
          ? `, average position ${formatValue(position.value, 'position')} (was ${formatValue(position.previous, 'position')})`
          : '';
      watch.push({
        tone: 'watch',
        title: `${lower ? 'Higher' : 'Fewer'} ${worst.label.toLowerCase()} on ${r.name}`,
        text: `${formatValue(worst.value!, worst.unit)}, ${lower ? 'up' : 'down'} from ${formatValue(worst.previous!, worst.unit)}${positionNote}. ${
          r.source === 'Search Console'
            ? 'Check Search Console for the pages that dropped.'
            : r.source === 'Play vitals'
              ? 'Check Android vitals for the release that changed.'
              : 'Check GA4 for the pages or channels that dropped.'
        }`,
      });
    }
    const moved = primary ? change(primary.value, primary.previous) : null;
    const pct =
      primary?.value != null && primary.previous
        ? ((primary.value - primary.previous) / primary.previous) * 100
        : 0;
    cards.push({
      name: r.name,
      subtitle: [r.source, r.partial ? 'partial day' : '', lagged ? `latest data ${shortDate(lagged)}` : '']
        .filter(Boolean)
        .join(' · '),
      tone: worst ? 'watch' : pct >= MOVE ? 'good' : 'neutral',
      label: worst ? 'Dropped' : pct >= MOVE ? 'Growing' : moved ? 'Steady' : 'No data',
      compare:
        primary && primary.value != null && primary.previous != null
          ? {
              label: primary.label,
              previous: primary.previous,
              current: primary.value,
              previousLabel: weekday(primary.previousDay) || 'Before',
              currentLabel: weekday(primary.day ?? a?.reportDay) || 'Today',
            }
          : null,
      rows: r.values.map((v) => {
        if (v.value == null) return [v.label, 'No data'];
        const c = change(v.value, v.previous, { lowerIsBetter: lowerIsBetter(v.label, r.source) });
        const was =
          v.previous != null && v.unit === 'position' ? ` (was ${formatValue(v.previous, v.unit)})` : '';
        return [
          v.label,
          `${formatValue(v.value, v.unit)}${was || (c && c.text !== 'No change' ? `  ${c.text}` : '')}`,
        ];
      }),
    });
  }
  return { cards, quiet };
}

function hostCards(hosts: HostStats[], watch: WatchItem[]): HostCard[] {
  return hosts.map((h) => {
    const fullest = Math.max(h.memoryAvg ?? 0, h.diskMax ?? 0);
    for (const [what, v] of [
      ['disk', h.diskMax],
      ['memory', h.memoryAvg],
    ] as const)
      if (v != null && v >= 85)
        watch.push({
          tone: v >= 95 ? 'attention' : 'watch',
          title: `${h.hostname} ${what} is ${whole(v)} ${what === 'disk' ? 'full' : 'used'}`,
          text:
            what === 'disk'
              ? 'Free some space or grow the disk before it fills.'
              : 'Check which process is using the memory.',
        });
    const none = h.cpuAvg == null && h.memoryAvg == null && h.diskMax == null;
    return {
      name: h.hostname,
      subtitle: 'Server',
      tone: none ? 'neutral' : fullest >= 95 ? 'attention' : fullest >= 85 ? 'watch' : 'good',
      label: none ? 'No data' : fullest >= 95 ? 'Nearly full' : fullest >= 85 ? 'Getting full' : 'Healthy',
      rows: [],
      bars: [
        {
          label: 'CPU',
          percent: h.cpuAvg,
          detail:
            h.cpuAvg == null
              ? 'No data'
              : `${whole(h.cpuAvg)} average${h.cpuMax == null ? '' : ` · peak ${whole(h.cpuMax)}`}`,
        },
        {
          label: 'Memory',
          percent: h.memoryAvg,
          detail: h.memoryAvg == null ? 'No data' : whole(h.memoryAvg),
        },
        {
          label: 'Disk',
          percent: h.diskMax,
          detail: h.diskMax == null ? 'No data' : `${whole(h.diskMax)} full`,
        },
      ],
    };
  });
}

function websiteCards(sites: WebsiteStats[], watch: WatchItem[]): WebsiteCard[] {
  return sites.map((w) => {
    const up = w.uptimePercent;
    const name = host(w.url);
    if (up != null && up < 99)
      watch.push({
        tone: up < 95 ? 'attention' : 'watch',
        title: `${name} was down part of the day`,
        text: `Up ${up}%${w.failedChecks ? ` with ${count(w.failedChecks)} failed checks` : ''}. Open the website monitor to see when.`,
      });
    if (w.tlsDays != null && w.tlsDays <= 14)
      watch.push({
        tone: w.tlsDays <= 3 ? 'attention' : 'watch',
        title: `Certificate for ${name} expires in ${w.tlsDays} days`,
        text: 'Renew it before visitors see a security warning.',
      });
    if (w.avgMs != null && w.previousAvgMs && w.avgMs >= 500 && w.avgMs >= w.previousAvgMs * 1.5)
      watch.push({
        tone: 'watch',
        title: `${name} got slower`,
        text: `Pages took ${count(w.avgMs)} ms on average, up from ${count(w.previousAvgMs)} ms.`,
      });
    const speed = change(w.avgMs, w.previousAvgMs, { lowerIsBetter: true });
    return {
      name,
      subtitle: 'Website',
      tone: up == null ? 'neutral' : up < 95 ? 'attention' : up < 99 ? 'watch' : 'good',
      label: up == null ? 'No data' : `Up ${up}%`,
      hourly: w.hourly ?? [],
      rows: [
        ...(w.avgMs != null
          ? [
              [
                'Response time',
                `${count(w.avgMs)} ms average${speed && speed.text !== 'No change' ? `  ${speed.text}` : ''}`,
              ] as [string, string],
            ]
          : []),
        ...(w.failedChecks ? [['Failed checks', count(w.failedChecks)] as [string, string]] : []),
        ...(w.tlsDays != null ? [['Certificate', `${w.tlsDays} days left`] as [string, string]] : []),
      ],
    };
  });
}

const bytes = (v: number) => {
  const a = Math.abs(v);
  return a >= 1024 ** 3
    ? `${Math.round((v / 1024 ** 3) * 10) / 10} GB`
    : a >= 1024 ** 2
      ? `${Math.round((v / 1024 ** 2) * 10) / 10} MB`
      : `${Math.round(v / 1024)} KB`;
};

function databaseCards(dbs: DatabaseStats[], watch: WatchItem[]): Card[] {
  return dbs.map((d) => {
    if (d.ok === false)
      watch.push({
        tone: 'attention',
        title: `Database ${d.name} needs attention`,
        text: `It reported: ${d.status}.`,
      });
    const a = d.activity;
    return {
      name: d.name,
      subtitle: d.provider,
      tone: d.ok === true ? 'good' : d.ok === false ? 'attention' : 'neutral',
      label: d.ok === true ? 'Healthy' : d.ok === false ? 'Needs attention' : 'Unknown',
      rows: [
        ...(a
          ? [
              [
                'New records',
                a.baseline === 'ok'
                  ? `${count(a.rowsAdded ?? 0)}${a.approximate ? ' (estimated)' : ''}`
                  : a.baseline === 'none'
                    ? 'Counted from tomorrow'
                    : 'Statistics were reset',
              ] as [string, string],
              ...(a.sizeBytes != null
                ? [
                    [
                      'Size',
                      `${bytes(a.sizeBytes)}${a.sizeChangeBytes ? ` (${a.sizeChangeBytes > 0 ? '+' : '−'}${bytes(Math.abs(a.sizeChangeBytes))})` : ''}`,
                    ] as [string, string],
                  ]
                : []),
              ...a.top
                .filter((t) => t.added)
                .slice(0, 3)
                .map(
                  (t) =>
                    [t.name, t.isNew ? `new, ${count(t.total)}` : `+${count(t.added!)}`] as [string, string],
                ),
            ]
          : [['Status', d.status] as [string, string]]),
      ],
    };
  });
}

function fallbackSummary(s: Snapshot, d: Omit<Digest, 'summary'>): string {
  const parts: string[] = [];
  const inc = data<IncidentStats>(s, 'health');
  if (inc)
    parts.push(
      inc.openNow
        ? `${inc.openNow} incident${inc.openNow === 1 ? '' : 's'} open${inc.openCritical ? ` (${inc.openCritical} critical)` : ''}.`
        : inc.opened
          ? `${inc.opened} incident${inc.opened === 1 ? ' was' : 's were'} opened and resolved.`
          : 'No incidents.',
    );
  const sites =
    data<{ websites: WebsiteStats[] }>(s, 'availability')?.websites.filter((w) => w.uptimePercent != null) ??
    [];
  if (sites.length) {
    const many = sites.length > 1;
    parts.push(
      sites.every((w) => w.uptimePercent! >= 99.9)
        ? `Your website${many ? 's were' : ' was'} up all day.`
        : `${many ? 'Lowest website uptime' : 'Website uptime'} was ${Math.min(...sites.map((w) => w.uptimePercent!))}%.`,
    );
  }
  const lead = d.kpis.find((k) => k.change && /[▲▼]/.test(k.change.text) && !k.key.startsWith('incidents'));
  if (lead)
    parts.push(
      `${lead.label} ${lead.display}, ${lead.change!.text.startsWith('▲') ? 'up' : 'down'} ${lead.change!.text.slice(2)} from the day before.`,
    );
  parts.push(
    d.watch.length
      ? `${d.watch.length} thing${d.watch.length === 1 ? ' is' : 's are'} worth a look.`
      : 'Nothing needs your attention.',
  );
  return parts.join(' ');
}

export function digest(s: Snapshot, narrative: string | null): Digest {
  const watch: WatchItem[] = [];
  const incidents = data<IncidentStats>(s, 'health');
  if (incidents?.openNow)
    watch.push({
      tone: 'attention',
      title: `${incidents.openNow} incident${incidents.openNow === 1 ? '' : 's'} open`,
      text: `${incidents.openCritical ? `${incidents.openCritical} critical. ` : ''}Open Incidents & Alerts to see what is affected.`,
    });
  const hosts = hostCards(data<{ hosts: HostStats[] }>(s, 'infrastructure')?.hosts ?? [], watch);
  const websites = websiteCards(data<{ websites: WebsiteStats[] }>(s, 'availability')?.websites ?? [], watch);
  const analytics = data<AnalyticsStats>(s, 'analytics');
  const { cards: analyticsList, quiet } = analyticsCards(analytics, watch);
  const databases = databaseCards(
    data<{ databases: DatabaseStats[] }>(s, 'databases')?.databases ?? [],
    watch,
  );

  const activity: Card[] = [];
  const logs = data<{ errors: number; warnings: number }>(s, 'application');
  const logJump = s.anomalies.find((a) => a.metric === 'Log errors' && a.changePercent > 0);
  if (logJump)
    watch.push({
      tone: 'watch',
      title: 'More errors in your logs',
      text: `${count(logJump.current)} errors, up from ${count(logJump.previous)}. Search the logs for what changed.`,
    });
  if (logs)
    activity.push({
      name: 'App logs',
      subtitle: 'Errors and warnings',
      tone: logJump ? 'watch' : 'neutral',
      label: logJump ? 'More errors' : 'Steady',
      rows: [
        ['Errors', count(logs.errors)],
        ['Warnings', count(logs.warnings)],
      ],
    });
  const deploys = data<DeploymentStats>(s, 'deployments');
  if (deploys) {
    if (deploys.failed)
      watch.push({
        tone: 'watch',
        title: `${deploys.failed} deployment${deploys.failed === 1 ? '' : 's'} failed`,
        text: 'Check the failed run before the next release.',
      });
    activity.push({
      name: 'Deployments',
      subtitle: 'From GitHub',
      tone: deploys.failed ? 'watch' : 'neutral',
      label: deploys.failed ? `${deploys.failed} failed` : `${deploys.deployed} shipped`,
      rows: deploys.items
        .slice(0, 5)
        .map((i) => [i.title, i.kind === 'deployment_failed' ? 'Failed' : 'Shipped']),
    });
  }

  // Headline numbers: Google first, then incidents, then whatever else the product has.
  const kpis: Kpi[] = [];
  const add = (k: Kpi) => kpis.length < 4 && !kpis.some((x) => x.key === k.key) && kpis.push(k);
  const google: Kpi[] = [];
  for (const r of analytics?.resources ?? []) {
    if (isQuiet(r)) continue;
    for (const label of PRIMARY[r.source] ?? []) {
      const v = r.values.find((x) => x.label === label && x.value != null);
      if (!v || google.some((g) => g.label === KPI_LABEL[label])) continue;
      const key = `ga:${r.name}:${label}`;
      google.push({
        key,
        label: KPI_LABEL[label] ?? label,
        display: formatValue(v.value!, v.unit),
        change: change(v.value, v.previous, {
          previousDay: v.previousDay,
          lowerIsBetter: lowerIsBetter(label, r.source),
        }),
        series: series(s, key, v.value),
        note: r.name,
      });
    }
  }
  google.slice(0, 3).forEach(add);
  if (incidents)
    add({
      key: 'incidents.opened',
      label: 'Incidents',
      display: count(incidents.opened),
      change: null,
      series: series(s, 'incidents.opened', incidents.opened),
      note: `${incidents.openNow} open now`,
    });
  const site = data<{ websites: WebsiteStats[] }>(s, 'availability')?.websites.find(
    (w) => w.uptimePercent != null,
  );
  if (site)
    add({
      key: `web:${site.url}:uptime`,
      label: 'Uptime',
      display: `${site.uptimePercent}%`,
      change: null,
      series: series(s, `web:${site.url}:uptime`, site.uptimePercent),
      note: host(site.url),
    });
  const busiest = (data<{ hosts: HostStats[] }>(s, 'infrastructure')?.hosts ?? []).find(
    (h) => h.cpuAvg != null,
  );
  if (busiest)
    add({
      key: `host:${busiest.hostname}:cpu`,
      label: 'Server CPU',
      display: whole(busiest.cpuAvg!),
      change: null,
      series: series(s, `host:${busiest.hostname}:cpu`, busiest.cpuAvg),
      note: busiest.hostname,
    });
  if (logs)
    add({
      key: 'logs.errors',
      label: 'Log errors',
      display: count(logs.errors),
      change: logJump ? change(logJump.current, logJump.previous, { lowerIsBetter: true }) : null,
      series: series(s, 'logs.errors', logs.errors),
    });

  const notConnected = [...new Set(s.coverage.filter((c) => c.status === 'missing').map((c) => c.source))];
  const order = { attention: 0, watch: 1 } as const;
  watch.sort((a, b) => order[a.tone] - order[b.tone]);
  const rest = {
    status: watch.some((x) => x.tone === 'attention')
      ? ({ tone: 'attention', label: 'Needs attention' } as const)
      : watch.length
        ? ({ tone: 'watch', label: 'Worth a look' } as const)
        : ({ tone: 'good', label: 'All good' } as const),
    kpis,
    hosts,
    websites,
    analytics: analyticsList,
    databases,
    activity,
    watch,
    quiet,
    notConnected,
  };
  const plain = narrative ? plainNarrative(narrative) : '';
  return { ...rest, summary: plain || fallbackSummary(s, rest) };
}
