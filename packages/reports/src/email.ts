import type { AnalyticsCard, Bar, Card, Digest, HostCard, Kpi, Tone, WebsiteCard } from './digest.js';
import type { RenderableReport } from './render.js';

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fg = '#161618';
const muted = '#626268';
const line = '#e4e4e9';
const accent = '#c95100';
const track = '#ececf1';
const tones: Record<Tone, [string, string]> = {
  neutral: ['#f2f2f7', muted],
  good: ['#edf7ef', '#15803d'],
  watch: ['#fff7e6', '#8c5700'],
  attention: ['#fff0ef', '#b91c1c'],
};
const T = 'role="presentation" width="100%" cellpadding="0" cellspacing="0"';

function pill(label: string, tone: Tone): string {
  const [background, color] = tones[tone];
  return `<span style="display:inline-block;padding:4px 10px;border-radius:20px;background:${background};color:${color};font-size:12px;line-height:16px;font-weight:600">&#9679;&nbsp;${escape(label)}</span>`;
}

const eyebrow = (text: string) =>
  `<p style="margin:0;color:${muted};font-size:11px;line-height:16px;letter-spacing:.6px;text-transform:uppercase">${escape(text)}</p>`;

function card(inner: string): string {
  return `<table ${T} style="margin:0 0 12px;background:#fff;border:1px solid ${line};border-radius:20px;border-collapse:separate;table-layout:fixed"><tr><td style="padding:20px 22px">${inner}</td></tr></table>`;
}

function head(title: string, subtitle: string, status?: [string, Tone]): string {
  return `<table ${T}><tr><td style="vertical-align:top"><p style="margin:0;font-size:16px;line-height:22px;font-weight:600;overflow-wrap:anywhere">${escape(title)}</p>${subtitle ? `<p style="margin:2px 0 0;font-size:12px;line-height:18px;color:${muted};overflow-wrap:anywhere">${escape(subtitle)}</p>` : ''}</td>${status ? `<td align="right" style="vertical-align:top;white-space:nowrap">${pill(...status)}</td>` : ''}</tr></table>`;
}

function rows(items: Array<[string, string]>): string {
  if (!items.length) return '';
  return `<table ${T} style="margin-top:10px;border-collapse:collapse">${items
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 0;border-top:1px solid ${line};font-size:13px;line-height:19px;color:${muted};overflow-wrap:anywhere">${escape(label)}</td><td align="right" style="padding:8px 0 8px 12px;border-top:1px solid ${line};font-size:13px;line-height:19px;font-weight:600">${escape(value)}</td></tr>`,
    )
    .join('')}</table>`;
}

/** A filled track drawn with table cells, which Outlook and Gmail both render. */
function meter(percent: number | null, color = fg): string {
  const p = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
  return `<table ${T} style="margin:6px 0 0;background:${track};border-radius:4px;border-collapse:separate"><tr>${p > 0 ? `<td width="${p}%" height="6" style="height:6px;background:${color};border-radius:4px;font-size:0;line-height:0">&nbsp;</td>` : ''}${p < 100 ? `<td height="6" style="height:6px;font-size:0;line-height:0">&nbsp;</td>` : ''}</tr></table>`;
}

function bars(list: Bar[]): string {
  return list
    .map(
      (b) =>
        `<table ${T} style="margin-top:12px"><tr><td style="font-size:13px;line-height:18px">${escape(b.label)}</td><td align="right" style="font-size:13px;line-height:18px;color:${muted}">${escape(b.detail)}</td></tr></table>${meter(b.percent)}`,
    )
    .join('');
}

/** The 7-day trend as small columns: email clients run no charts and most drop inline SVG. */
function columns(series: Array<number | null>): string {
  const values = series.filter((v): v is number => v !== null);
  const max = Math.max(...values);
  if (values.length < 2 || max <= 0) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr>${series
    .map((v, i) => {
      const h = v === null ? 0 : Math.max(2, Math.round((v / max) * 28));
      const last = i === series.length - 1;
      return `<td valign="bottom" style="padding:0 3px 0 0;height:28px;vertical-align:bottom"><div style="width:10px;height:${h}px;background:${last ? accent : '#d6d6dc'};border-radius:2px;font-size:0;line-height:0">&nbsp;</div></td>`;
    })
    .join('')}</tr></table>`;
}

function kpiCell(k: Kpi, i: number): string {
  const c = k.change;
  const color = !c || c.good === null ? muted : c.good ? '#15803d' : '#b91c1c';
  const sub = c
    ? `<span style="color:${color};font-weight:600">${escape(c.text)}</span>${c.against ? ` ${escape(c.against)}` : ''}`
    : escape(k.note ?? '');
  return `<td class="kpi" width="50%" style="padding:0 ${i % 2 ? '0 12px 6px' : '6px 12px 0'};vertical-align:top"><table ${T} style="background:#fff;border:1px solid ${line};border-radius:20px;border-collapse:separate"><tr><td style="padding:18px 20px">${eyebrow(k.label)}<p style="margin:8px 0 2px;font-size:28px;line-height:34px;font-weight:600;letter-spacing:-.5px">${escape(k.display)}</p><p style="margin:0;font-size:12px;line-height:18px;color:${muted}">${sub}</p>${columns(k.series)}</td></tr></table></td>`;
}

function kpiGrid(kpis: Kpi[]): string {
  if (!kpis.length) return '';
  const pairs: Kpi[][] = [];
  for (let i = 0; i < kpis.length; i += 2) pairs.push(kpis.slice(i, i + 2));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed">${pairs
    .map(
      (p) =>
        `<tr>${p.map((k, i) => kpiCell(k, i)).join('')}${p.length === 1 ? '<td class="kpi" width="50%"></td>' : ''}</tr>`,
    )
    .join('')}</table>`;
}

function strip(hourly: Array<number | null>): string {
  if (!hourly.length) return '';
  const color = (v: number | null) =>
    v === null ? track : v >= 99.9 ? '#bfe3c9' : v >= 95 ? '#f5d9a3' : '#f2b8b5';
  return `<table ${T} style="margin-top:12px;table-layout:fixed;border-collapse:separate;border-spacing:2px 0"><tr>${hourly
    .map(
      (v) =>
        `<td height="22" style="height:22px;background:${color(v)};border-radius:3px;font-size:0;line-height:0">&nbsp;</td>`,
    )
    .join(
      '',
    )}</tr></table><table ${T}><tr><td style="font-size:11px;color:${muted};padding-top:4px">00:00</td><td align="right" style="font-size:11px;color:${muted};padding-top:4px">24:00</td></tr></table>`;
}

function compare(c: AnalyticsCard['compare']): string {
  if (!c) return '';
  const max = Math.max(c.previous, c.current) || 1;
  const row = (label: string, value: number, color: string, bold: boolean) =>
    `<tr><td width="44" style="font-size:12px;color:${bold ? fg : muted};padding:4px 0">${escape(label)}</td><td style="padding:4px 8px">${meter((value / max) * 100, color)}</td><td width="56" align="right" style="font-size:12px;${bold ? 'font-weight:600' : `color:${muted}`}">${Math.round(value).toLocaleString('en-US')}</td></tr>`;
  return `<p style="margin:12px 0 0;font-size:12px;color:${muted}">${escape(c.label)}</p><table ${T}>${row(c.previousLabel, c.previous, '#c7c7cc', false)}${row(c.currentLabel, c.current, accent, true)}</table>`;
}

const status = (c: Card): [string, Tone] => [c.label, c.tone];
const hostCard = (h: HostCard) => card(head(h.name, h.subtitle, status(h)) + bars(h.bars));
const siteCard = (w: WebsiteCard) =>
  card(head(w.name, w.subtitle, status(w)) + strip(w.hourly) + rows(w.rows));
const googleCard = (a: AnalyticsCard) =>
  card(head(a.name, a.subtitle, status(a)) + compare(a.compare) + rows(a.rows));
const plainCard = (c: Card) => card(head(c.name, c.subtitle, status(c)) + rows(c.rows));

function group(title: string, cards: string[]): string {
  return cards.length
    ? `<p style="margin:20px 4px 10px;font-size:13px;line-height:18px;font-weight:600;color:${muted}">${escape(title)}</p>${cards.join('')}`
    : '';
}

/** Cards and simple graphics from tables and inline styles: no stylesheet, no remote images. */
export function reportEmail(r: RenderableReport, link: string, d: Digest): string {
  const w = r.snapshot.window;
  const href = /^https?:\/\//i.test(link) ? escape(link) : '#';
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${w.localDate}T12:00:00Z`));
  const deferred =
    r.narrativeStatus === 'deferred'
      ? `<p style="margin:10px 0 0;font-size:12px;line-height:18px;color:${muted}">The AI summary could not be checked against the data, so this one is written from the numbers.</p>`
      : '';
  const watch = group(
    'Worth a look',
    d.watch.map((x) => {
      return card(
        `<table ${T}><tr><td style="vertical-align:top"><p style="margin:0;font-size:15px;line-height:21px;font-weight:600;overflow-wrap:anywhere">${escape(x.title)}</p><p style="margin:4px 0 0;font-size:13px;line-height:20px;color:${muted}">${escape(x.text)}</p></td><td align="right" style="vertical-align:top;white-space:nowrap;padding-left:12px">${pill(x.tone === 'attention' ? 'Urgent' : 'Check', x.tone)}</td></tr></table>`,
      );
    }),
  );
  const missing = [
    ...(d.notConnected.length
      ? [
          `<p style="margin:0 0 10px;font-size:14px;font-weight:600">Not connected yet</p><p style="margin:0">${d.notConnected
            .map(
              (n) =>
                `<span style="display:inline-block;margin:0 6px 6px 0;padding:5px 12px;border:1px solid ${line};border-radius:20px;font-size:12px;color:${fg}">${escape(n)}</span>`,
            )
            .join('')}</p>`,
        ]
      : []),
    ...(d.quiet.length
      ? [
          `<p style="margin:8px 0 0;font-size:12px;line-height:18px;color:${muted}">No activity yesterday: ${escape(d.quiet.join(', '))}.</p>`,
        ]
      : []),
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Daily report — ${escape(r.productName)}</title><style>@media only screen and (max-width:600px){.outer{padding:16px 8px!important}.kpi{display:block!important;width:100%!important;padding:0 0 12px!important}}body{margin:0;padding:0}a{color:${accent}}</style></head><body style="margin:0;background:#f2f2f7;color:${fg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%"><div style="display:none;font-size:1px;line-height:1px;color:#f2f2f7;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escape(d.status.label)} · ${escape(d.summary)}</div><table ${T} style="background:#f2f2f7"><tr><td class="outer" align="center" style="padding:32px 16px"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;table-layout:fixed"><tr><td style="padding:0 4px 20px">${eyebrow(`Daily report · ${r.productName}`)}<h1 style="margin:6px 0 4px;font-size:26px;line-height:32px;letter-spacing:-.4px;overflow-wrap:anywhere">${escape(date)}</h1><p style="margin:0;font-size:13px;line-height:20px;color:${muted}">${w.hours} h in ${escape(w.timezone)}${r.late ? ' · Generated late, same reporting day' : ''}</p></td></tr><tr><td>${card(`${pill(d.status.label, d.status.tone)}<p style="margin:14px 0 0;font-size:16px;line-height:25px;overflow-wrap:anywhere">${escape(d.summary)}</p>${deferred}`)}${kpiGrid(d.kpis)}${watch}${group('Servers', d.hosts.map(hostCard))}${group('Websites', d.websites.map(siteCard))}${group('Google', d.analytics.map(googleCard))}${group('Databases', d.databases.map(plainCard))}${group('Activity', d.activity.map(plainCard))}${missing ? card(missing) : ''}<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px auto 0"><tr><td bgcolor="${accent}" style="border-radius:12px"><a href="${href}" style="display:inline-block;padding:13px 22px;color:#fff;font-size:14px;line-height:20px;font-weight:600;text-decoration:none">Open full report &rarr;</a></td></tr></table><p style="margin:16px 0 0;text-align:center;font-size:11px;line-height:18px;color:${muted}">Every number is in the full report · Product Control Plane</p></td></tr></table></td></tr></table></body></html>`;
}
