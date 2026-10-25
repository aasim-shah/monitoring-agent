import type { RenderableReport } from './render.js';
import type {
  AnalyticsStats,
  Anomaly,
  CoverageItem,
  DatabaseStats,
  DeploymentStats,
  HostStats,
  IncidentStats,
  Section,
  WebsiteStats,
} from './snapshot.js';

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const muted = '#626268';
const line = '#e4e4e9';
const percent = (n: number | null) => (n === null ? 'No data' : `${n.toFixed(1)} %`);

function rows(items: Array<[string, string]>): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${items.map(([label, value]) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${line};color:${muted};font-size:13px;line-height:20px;vertical-align:top;width:55%">${escape(label)}</td><td align="right" style="padding:10px 0 10px 12px;border-bottom:1px solid ${line};font-size:14px;line-height:20px;vertical-align:top;font-weight:600">${escape(value)}</td></tr>`).join('')}</table>`;
}

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
const tones: Record<Tone, [string, string]> = {
  neutral: ['#f2f2f7', muted],
  accent: ['#fff1e8', '#c95100'],
  success: ['#edf7ef', '#15803d'],
  warning: ['#fff7e6', '#8c5700'],
  danger: ['#fff0ef', '#b91c1c'],
};

function badge(label: string, tone: Tone = 'neutral'): string {
  const [background, color] = tones[tone];
  return `<span style="display:inline-block;padding:4px 9px;border-radius:20px;background:${background};color:${color};font-size:11px;line-height:16px;font-weight:600">${escape(label)}</span>`;
}

function panel(title: string, subtitle: string, content: string, status = ''): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid ${line};border-radius:16px;border-collapse:separate;table-layout:fixed"><tr><td style="padding:18px"><p style="margin:0 0 6px;font-size:14px;line-height:21px;font-weight:600;overflow-wrap:anywhere">${escape(title)}</p>${subtitle ? `<p style="margin:0 0 12px;font-size:12px;line-height:19px;color:${muted};overflow-wrap:anywhere">${escape(subtitle)}</p>` : ''}${status ? `<p style="margin:0 0 12px">${status}</p>` : ''}${content}</td></tr></table>`;
}

function notice(title: string, description: string, tone: Tone = 'neutral'): string {
  const [background, color] = tones[tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;border-collapse:separate;border-radius:12px;background:${background}"><tr><td style="padding:16px;border-left:3px solid ${color};border-radius:12px"><p style="margin:0;font-size:13px;line-height:20px;font-weight:600;color:${color};overflow-wrap:anywhere">${escape(title)}</p>${description ? `<p style="margin:6px 0 0;font-size:13px;line-height:21px;color:${muted};overflow-wrap:anywhere">${escape(description)}</p>` : ''}</td></tr></table>`;
}

function sectionBody(section: Section, lines: string[]): string {
  if (section.status === 'missing') {
    return notice('No data', section.reason ?? 'Source unavailable', 'warning');
  }
  switch (section.key) {
    case 'health': {
      const d = section.data as IncidentStats;
      return `${badge(d.openCritical > 0 ? 'Critical incidents open' : d.openNow > 0 ? 'Open incidents' : 'No open incidents', d.openCritical > 0 ? 'danger' : d.openNow > 0 ? 'warning' : 'success')}${rows(
        [
          ['Opened in this period', String(d.opened)],
          ['Resolved in this period', String(d.resolved)],
          ['Currently open', String(d.openNow)],
          ['Critical open', String(d.openCritical)],
        ],
      )}`;
    }
    case 'infrastructure':
      return (
        (section.data as { hosts: HostStats[] }).hosts
          .map((h) =>
            panel(
              h.hostname,
              'Host resource utilization',
              rows([
                ['Average CPU', percent(h.cpuAvg)],
                ['Peak CPU', percent(h.cpuMax)],
                ['Average memory', percent(h.memoryAvg)],
                ['Fullest disk', percent(h.diskMax)],
              ]),
            ),
          )
          .join('') || notice('No hosts in this snapshot', 'No host resource metrics are available.')
      );
    case 'application': {
      const d = section.data as { errors: number; warnings: number };
      return panel(
        'Application logs',
        'Observed log events in this reporting period',
        rows([
          ['Errors', String(d.errors)],
          ['Warnings', String(d.warnings)],
        ]),
      );
    }
    case 'analytics':
      return (
        (section.data as AnalyticsStats).resources
          .map((r) =>
            panel(
              r.name,
              r.source,
              rows(
                r.values.map((v) => [
                  v.label,
                  v.value === null
                    ? 'No data'
                    : v.unit === 'ratio'
                      ? `${Math.round(v.value * 1000) / 10} %`
                      : String(Math.round(v.value * 100) / 100),
                ]),
              ),
              r.partial
                ? badge('Partial day', 'warning') +
                    `<p style="margin:8px 0 0;color:${muted};font-size:12px;line-height:19px">Partial day — provider still processing</p>`
                : '',
            ),
          )
          .join('') || notice('No analytics values', 'No properties or apps have values in this snapshot.')
      );
    case 'databases':
      return (
        (section.data as { databases: DatabaseStats[] }).databases
          .map((d) =>
            panel(
              d.name,
              d.provider,
              rows([['Reported status', d.status]]),
              badge(
                d.ok === true ? 'Healthy' : d.ok === false ? 'Needs attention' : 'Unknown',
                d.ok === true ? 'success' : d.ok === false ? 'warning' : 'neutral',
              ),
            ),
          )
          .join('') || notice('No database values', 'No database observations are available.')
      );
    case 'deployments': {
      const d = section.data as DeploymentStats;
      return (
        rows([
          ['Deployments', String(d.deployed)],
          ['Failed', String(d.failed)],
        ]) +
        d.items
          .slice(0, 10)
          .map((i) => panel(i.title, i.kind, rows([['Recorded at (UTC)', i.occurredAt]])))
          .join('')
      );
    }
    case 'availability':
      return (
        (section.data as { websites: WebsiteStats[] }).websites
          .map((w) =>
            panel(
              w.url,
              'Website monitor',
              rows([
                ['Uptime', percent(w.uptimePercent)],
                ['Certificate remaining', w.tlsDays === null ? 'No data' : `${w.tlsDays} days`],
              ]),
            ),
          )
          .join('') || notice('No availability values', 'No website observations are available.')
      );
    case 'anomalies': {
      const anomalies = section.data as Anomaly[];
      return anomalies.length
        ? anomalies
            .map((a) =>
              panel(
                a.metric,
                'Compared with the previous day',
                rows([
                  ['Previous value', String(a.previous)],
                  ['Current value', String(a.current)],
                  ['Change', `${a.changePercent > 0 ? '+' : ''}${a.changePercent} %`],
                ]),
                badge(
                  a.changePercent > 0 ? 'Increased' : a.changePercent < 0 ? 'Decreased' : 'Unchanged',
                  'accent',
                ),
              ),
            )
            .join('')
        : notice('No significant changes', 'No significant changes against the previous day.');
    }
    case 'actions': {
      const actions = section.data as string[];
      return actions.length
        ? actions.map((action, index) => notice(`Suggested action ${index + 1}`, action, 'accent')).join('')
        : notice('No actions suggested', 'Review the full report for source context.');
    }
    case 'coverage':
      return (
        (section.data as CoverageItem[])
          .map((c) =>
            panel(
              c.source,
              c.reason ?? '',
              '',
              badge(
                c.status === 'ok' ? 'Complete' : c.status === 'partial' ? 'Partial' : 'Missing',
                c.status === 'ok' ? 'success' : 'warning',
              ),
            ),
          )
          .join('') || notice('No coverage details', 'Source coverage is unavailable for this snapshot.')
      );
    default:
      return lines.map((l) => notice('Reported observation', l)).join('');
  }
}

/** Table layout and inline styles keep the report usable without CSS or remote images. */
export function reportEmail(
  r: RenderableReport,
  link: string,
  narrative: string,
  linesFor: (section: Section) => string[],
): string {
  const { snapshot } = r;
  const w = snapshot.window;
  const health = snapshot.sections.find((s) => s.key === 'health' && s.status === 'ok')?.data as
    | IncidentStats
    | undefined;
  const available = snapshot.coverage.filter((c) => c.status === 'ok').length;
  const href = /^https?:\/\//i.test(link) ? escape(link) : '#';
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${w.localDate}T12:00:00Z`));
  const summary = `<tr><td class="content" style="padding:28px 32px;background:#fff;border-bottom:1px solid ${line}"><p style="margin:0 0 12px;color:#c95100;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase">The daily picture</p><h2 style="margin:0 0 14px;font-size:20px;line-height:26px">Executive summary</h2><p style="margin:0;font-size:15px;line-height:25px;overflow-wrap:anywhere;white-space:pre-line">${escape(narrative)}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;table-layout:fixed"><tr>${[
    ['Open now', health ? String(health.openNow) : 'No data'],
    ['Opened today', health ? String(health.opened) : 'No data'],
    ['Sources complete', `${available} / ${snapshot.coverage.length}`],
  ]
    .map(
      ([label, value]) =>
        `<td style="padding:14px 8px;background:#f2f2f7;vertical-align:top;border:2px solid #fff"><p style="margin:0 0 6px;color:${muted};font-size:11px;line-height:17px">${label}</p><p style="margin:0;font-size:22px;font-weight:700;line-height:28px">${value}</p></td>`,
    )
    .join(
      '',
    )}</tr></table><p style="margin:12px 0 0;font-size:12px;color:${muted};line-height:19px">${w.hours} h local reporting day. Missing and partial sources are listed below.</p></td></tr>`;
  const sections = snapshot.sections
    .filter((s) => s.key !== 'summary')
    .map(
      (s) =>
        `<tr><td class="section-wrap" style="padding:16px 16px 0;background:#f2f2f7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid ${line};border-radius:20px;table-layout:fixed"><tr><td class="section-content" style="padding:24px"><p style="margin:0 0 8px;color:#c95100;font-size:10px;line-height:16px;letter-spacing:1px;font-weight:700;text-transform:uppercase">${escape(s.id)} &middot; Product operations</p><h2 style="margin:0 0 20px;font-size:18px;line-height:25px;letter-spacing:-.2px">${escape(s.title)}</h2>${sectionBody(s, linesFor(s))}</td></tr></table></td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Daily report — ${escape(r.productName)}</title><style>@media only screen and (max-width:600px){.outer{padding:16px 8px!important}.content{padding:24px 20px!important}.report-title{font-size:26px!important}.section-wrap{padding:12px 8px 0!important}.section-content{padding:20px 16px!important}}body{margin:0;padding:0}a{color:#c95100}</style></head><body style="margin:0;background:#f2f2f7;color:#161618;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%"><div style="display:none;font-size:1px;line-height:1px;color:#f2f2f7;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escape(r.productName)} · ${date} · ${health ? `${health.openNow} open incidents` : 'Incident data unavailable'} · ${available} of ${snapshot.coverage.length} sources complete.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f7"><tr><td class="outer" align="center" style="padding:32px 16px"><table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px;border:1px solid ${line};border-radius:24px;overflow:hidden;table-layout:fixed"><tr><td class="content" style="padding:28px 32px;background:#fff;border-top:4px solid #c95100;border-bottom:1px solid ${line}"><p style="margin:0 0 28px;font-size:13px;font-weight:700">Product Control Plane</p><p style="margin:0 0 8px;color:#c95100;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase">Daily report</p><h1 class="report-title" style="margin:0 0 12px;font-size:30px;line-height:38px;letter-spacing:-.6px;overflow-wrap:anywhere">${escape(r.productName)}</h1><p style="margin:0;font-size:14px;line-height:22px;color:${muted}">${escape(date)} &middot; ${escape(w.timezone)} &middot; ${w.hours} h</p>${r.late ? '<p style="margin:12px 0 0;color:#8c5700;font-size:13px">Generated late · Reporting period is unchanged.</p>' : ''}<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px"><tr><td bgcolor="#c95100" style="border-radius:12px"><a href="${href}" style="display:inline-block;padding:14px 22px;color:#fff;font-size:13px;line-height:20px;font-weight:700;text-decoration:none">Open full report &rarr;</a></td></tr></table></td></tr>${summary}${sections}<tr><td height="16" style="background:#f2f2f7;font-size:0;line-height:0">&nbsp;</td></tr><tr><td class="content" style="padding:24px 32px;background:#fafafa"><p style="margin:0 0 12px;font-size:13px;line-height:21px;color:${muted}">Figures reflect this report snapshot. Source labels S1–S12 correspond to citations in the summary. Open the full report for evidence and context.</p><a href="${href}" style="font-size:13px;font-weight:600;color:#c95100">View report and evidence &rarr;</a><p style="margin:20px 0 0;font-size:11px;line-height:18px;color:${muted};overflow-wrap:anywhere">Reporting window (UTC)<br>${escape(w.start)} &rarr; ${escape(w.end)}</p><p style="margin:16px 0 0;font-size:11px;line-height:18px;color:${muted}">Product Control Plane &middot; Scheduled product operations report</p></td></tr></table></td></tr></table></body></html>`;
}
