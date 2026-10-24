import type { NarrativeStatus } from './narrative.js';
import type {
  AnalyticsStats,
  Anomaly,
  CoverageItem,
  DatabaseStats,
  HostStats,
  IncidentStats,
  Section,
  Snapshot,
  WebsiteStats,
} from './snapshot.js';

export type { Section, Snapshot } from './snapshot.js';

/** The same shape as an incident notification, so reports use the same channels (UC-15-03). */
export interface ReportMessage {
  subject: string;
  text: string;
  html: string;
  slack: { text: string };
  json: Record<string, unknown>;
}

export interface RenderableReport {
  snapshot: Snapshot;
  narrative: string | null;
  narrativeStatus: NarrativeStatus;
  productName: string;
  late: boolean;
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (v: number | null) => (v === null ? 'no data' : `${v.toFixed(1)} %`);

/** Plain lines for one section; numbers come straight from the snapshot (emails and the web view). */
export function sectionLines(s: Section): string[] {
  if (s.status === 'missing') return [`No data: ${s.reason}`];
  switch (s.key) {
    case 'summary': {
      const d = s.data as { windowHours: number; openIncidents: number; incidentsOpened: number };
      return [
        `${d.windowHours} h local day · ${d.incidentsOpened} incidents opened · ${d.openIncidents} open now`,
      ];
    }
    case 'health': {
      const d = s.data as IncidentStats;
      return [
        `Incidents opened: ${d.opened}, resolved: ${d.resolved}`,
        `Open now: ${d.openNow} (critical: ${d.openCritical})`,
      ];
    }
    case 'infrastructure':
      return (s.data as { hosts: HostStats[] }).hosts.map(
        (h) =>
          `${h.hostname}: CPU average ${pct(h.cpuAvg)}, peak ${pct(h.cpuMax)}; memory ${pct(h.memoryAvg)}; fullest disk ${pct(h.diskMax)}`,
      );
    case 'application': {
      const d = s.data as { errors: number; warnings: number };
      return [`Log errors: ${d.errors}, warnings: ${d.warnings}`];
    }
    case 'databases':
      return (s.data as { databases: DatabaseStats[] }).databases.map(
        (d) => `${d.name} (${d.provider}): ${d.status}`,
      );
    case 'analytics': {
      const d = s.data as AnalyticsStats;
      const fmt = (v: { value: number | null; unit: string }) =>
        v.value === null
          ? 'no data'
          : v.unit === 'ratio'
            ? `${Math.round(v.value * 1000) / 10} %`
            : String(Math.round(v.value * 100) / 100);
      return d.resources.map(
        (r) =>
          `${r.name} (${r.source}${r.partial ? ', partial day' : ''}): ${r.values.map((v) => `${v.label} ${fmt(v)}`).join(', ')}`,
      );
    }
    case 'deployments': {
      const d = s.data as { deployed: number; failed: number; items: Array<{ title: string }> };
      return [`Deployments: ${d.deployed}, failed: ${d.failed}`, ...d.items.slice(0, 10).map((i) => i.title)];
    }
    case 'availability':
      return (s.data as { websites: WebsiteStats[] }).websites.map(
        (w) =>
          `${w.url}: uptime ${pct(w.uptimePercent)}${w.tlsDays === null ? '' : `, certificate ${w.tlsDays} days left`}`,
      );
    case 'anomalies': {
      const a = s.data as Anomaly[];
      return a.length
        ? a.map(
            (x) =>
              `${x.metric}: ${x.previous} → ${x.current} (${x.changePercent > 0 ? '+' : ''}${x.changePercent} %)`,
          )
        : ['No significant changes against the previous day.'];
    }
    case 'actions': {
      const a = s.data as string[];
      return a.length ? a : ['No actions suggested.'];
    }
    case 'coverage':
      return (s.data as CoverageItem[]).map(
        (c) => `${c.source}: ${c.status === 'ok' ? 'complete' : c.status}${c.reason ? ` (${c.reason})` : ''}`,
      );
    default:
      return [JSON.stringify(s.data)];
  }
}

function narrativeText(r: RenderableReport): string {
  if (r.narrative) return r.narrative;
  return r.narrativeStatus === 'deferred'
    ? 'Narrative deferred: the AI summary could not be verified against the data.'
    : 'AI summary is turned off; the figures below are complete.';
}

/** Email (text + HTML), Slack, and webhook bodies for one report version. */
export function renderReport(r: RenderableReport, link: string): ReportMessage {
  const { snapshot } = r;
  const w = snapshot.window;
  const subject = `Daily report — ${r.productName} — ${w.localDate}`;
  const header = `${w.localDate} (${w.timezone}, ${w.hours} h) · ${w.start} to ${w.end}${r.late ? ' · Generated late' : ''}`;
  const body = snapshot.sections.map((s) =>
    s.key === 'summary'
      ? { title: s.title, lines: [narrativeText(r), ...sectionLines(s)] }
      : { title: s.title, lines: sectionLines(s) },
  );
  const text = [
    subject,
    header,
    '',
    ...body.flatMap((b) => [b.title, ...b.lines, '']),
    `Open the report: ${link}`,
  ].join('\n');
  const html = [
    `<h1>${escape(subject)}</h1>`,
    `<p>${escape(header)}</p>`,
    ...body.map(
      (b) => `<h2>${escape(b.title)}</h2><ul>${b.lines.map((l) => `<li>${escape(l)}</li>`).join('')}</ul>`,
    ),
    `<p><a href="${escape(link)}">Open the report</a></p>`,
  ].join('\n');
  const withData = snapshot.sections.filter((s) => s.status === 'ok').length;
  return {
    subject,
    text,
    html,
    slack: {
      text: `*${subject}*\n${narrativeText(r)}\n${withData} of ${snapshot.sections.length} sections have data. <${link}|Open the report>`,
    },
    json: {
      type: 'report',
      product: r.productName,
      localDate: w.localDate,
      link,
      narrativeStatus: r.narrativeStatus,
      narrative: r.narrative,
      late: r.late,
      snapshot,
    },
  };
}
