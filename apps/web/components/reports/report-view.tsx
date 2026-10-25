'use client';

import { PageHeading } from '@/components/shell/page-heading';

import { Fragment, useState, type ReactNode } from 'react';
import {
  digest,
  sectionLines,
  type Digest,
  type Kpi,
  type Section,
  type Snapshot,
  type Tone,
} from '@pcp/reports/render';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatLocal } from './format';

export interface DeliveryRow {
  id: string;
  kind: 'email' | 'slack' | 'webhook';
  target: string;
  status: 'pending' | 'sent' | 'failed' | 'dead';
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
}

export interface ReportData {
  id: string;
  localDate: string;
  version: number;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  narrative: string | null;
  narrativeStatus: 'verified' | 'deferred' | 'disabled';
  problems: string[];
  late: boolean;
  scheduleName: string | null;
  snapshot: Snapshot;
  deliveries: DeliveryRow[];
}

const DELIVERY = { pending: 'Pending', sent: 'Sent', failed: 'Retrying', dead: 'Failed' } as const;

const TONE: Record<Tone, string> = {
  good: 'bg-success/10 text-success',
  watch: 'bg-warning/10 text-warning',
  attention: 'bg-destructive/10 text-destructive',
  neutral: 'bg-foreground/5 text-muted-foreground',
};

function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap',
        TONE[tone],
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

const Eyebrow = ({ children }: { children: ReactNode }) => (
  <p className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{children}</p>
);

function Panel({
  title,
  subtitle,
  status,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  status?: { tone: Tone; label: string };
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn('rounded-[20px] border border-border bg-card p-5 sm:p-6', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, string]> }) {
  if (!rows.length) return null;
  return (
    <dl className="mt-3 divide-y divide-border text-[13px]">
      {rows.map(([label, value], i) => (
        <div key={`${label}-${i}`} className="flex justify-between gap-4 py-2">
          <dt className="min-w-0 truncate text-muted-foreground">{label}</dt>
          <dd className="shrink-0 font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Meter({ percent, className }: { percent: number | null; className?: string }) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]">
      <div className={cn('h-full rounded-full bg-foreground/85', className)} style={{ width: `${p}%` }} />
    </div>
  );
}

/**
 * The 7-day line: one series, so no legend. The line stretches to the card; points are HTML dots,
 * so they stay round, and each names its day and value on hover.
 */
function Sparkline({ label, series }: { label: string; series: Array<number | null> }) {
  const points = series.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  const values = points.map((p) => p.v);
  const [min, max] = [Math.min(...values), Math.max(...values)];
  if (points.length < 2 || max <= 0) return null;
  const x = (i: number) => (i / (series.length - 1)) * 100;
  const y = (v: number) => (max === min ? 50 : 88 - ((v - min) / (max - min)) * 76);
  const day = (i: number) =>
    i === series.length - 1
      ? 'Today'
      : `${series.length - 1 - i} day${series.length - 2 === i ? '' : 's'} before`;
  return (
    <div className="relative mt-3 h-8" role="img" aria-label={`${label}, last ${series.length} days`}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
      >
        <polyline
          fill="none"
          stroke="var(--primary)"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          points={points.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
        />
      </svg>
      {points.map((p) => {
        const last = p.i === series.length - 1;
        return (
          <span
            key={p.i}
            title={`${day(p.i)}: ${p.v.toLocaleString('en-US')}`}
            className="absolute flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
            style={{ left: `${x(p.i)}%`, top: `${y(p.v)}%` }}
          >
            {last ? <span className="size-2 rounded-full bg-primary ring-2 ring-card" /> : null}
          </span>
        );
      })}
    </div>
  );
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  const c = kpi.change;
  return (
    <section aria-label={kpi.label} className="rounded-[20px] border border-border bg-card p-5">
      <Eyebrow>{kpi.label}</Eyebrow>
      <p className="mt-2 text-[30px] font-semibold leading-9 tracking-tight">{kpi.display}</p>
      <p className="text-xs text-muted-foreground">
        {c ? (
          <>
            <span
              className={cn(
                'font-semibold',
                c.good === null ? undefined : c.good ? 'text-success' : 'text-destructive',
              )}
            >
              {c.text}
            </span>
            {c.against ? ` ${c.against}` : ''}
          </>
        ) : (
          kpi.note
        )}
      </p>
      <Sparkline label={kpi.label} series={kpi.series} />
    </section>
  );
}

function UptimeStrip({ hourly }: { hourly: Array<number | null> }) {
  if (!hourly.length) return null;
  return (
    <div className="mt-3">
      <div className="flex gap-[3px]">
        {hourly.map((v, i) => (
          <span
            key={i}
            title={`${String(i).padStart(2, '0')}:00 — ${v === null ? 'no checks' : `${v}% up`}`}
            className={cn(
              'h-6 flex-1 rounded-[4px]',
              v === null
                ? 'bg-foreground/[0.07]'
                : v >= 99.9
                  ? 'bg-success/30'
                  : v >= 95
                    ? 'bg-warning/35'
                    : 'bg-destructive/35',
            )}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>00:00</span>
        <span>Each block is one hour</span>
        <span>24:00</span>
      </div>
    </div>
  );
}

function Compare({ compare }: { compare: Digest['analytics'][number]['compare'] }) {
  if (!compare) return null;
  const max = Math.max(compare.previous, compare.current) || 1;
  const row = (label: string, value: number, current: boolean) => (
    <div className="grid grid-cols-[44px_1fr_56px] items-center gap-2.5 text-[13px]">
      <span className={current ? undefined : 'text-muted-foreground'}>{label}</span>
      <Meter percent={(value / max) * 100} className={current ? 'bg-primary' : 'bg-foreground/20'} />
      <span className={cn('text-right', current ? 'font-semibold' : 'text-muted-foreground')}>
        {Math.round(value).toLocaleString('en-US')}
      </span>
    </div>
  );
  return (
    <div className="mt-3 space-y-1.5">
      <Eyebrow>{compare.label}</Eyebrow>
      {row(compare.previousLabel, compare.previous, false)}
      {row(compare.currentLabel, compare.current, true)}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode[] | ReactNode[][] }) {
  if (!children.flat().length) return null;
  return (
    <div className="space-y-3">
      <h2 className="px-1 text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="grid gap-3 md:grid-cols-2">{children}</div>
    </div>
  );
}

/** `[S3]` citations become links to their section. */
function Cited({ text }: { text: string }) {
  const parts = text.split(/\[(S\d+)\]/);
  return (
    <p>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Fragment key={i}>
            [
            <a href={`#${part}`} className="underline">
              {part}
            </a>
            ]
          </Fragment>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

function SectionBlock({ section }: { section: Section }) {
  return (
    <section
      id={section.id}
      aria-label={section.title}
      className="space-y-1 rounded-2xl border border-border bg-card p-4"
    >
      <h3 className="text-sm font-semibold">
        {section.title} <span className="text-xs font-normal text-muted-foreground">{section.id}</span>
      </h3>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {sectionLines(section).map((line, i) => (
          <li key={i} className={section.status === 'missing' ? 'text-muted-foreground' : undefined}>
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Sunday, 25 October": built from parts so every runtime prints the same. */
function longDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
  return `${part({ weekday: 'long' })}, ${part({ day: 'numeric' })} ${part({ month: 'long' })}`;
}

/** One report version (UC-15-04/06): status and plain summary, cards, then every number and the delivery log. */
export function ReportView({
  report,
  canManage,
  onRegenerate,
}: {
  report: ReportData;
  canManage: boolean;
  onRegenerate: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const w = report.snapshot.window;
  const d = digest(report.snapshot, report.narrative);
  const summary = report.snapshot.sections.find((s) => s.key === 'summary');
  const failed = report.deliveries.filter((x) => x.status === 'dead').length;
  const sent = report.deliveries.filter((x) => x.status === 'sent').length;
  return (
    <div className="portal-feature-section space-y-5">
      <PageHeading
        eyebrow={`Daily report · v${report.version}`}
        title={longDate(report.localDate)}
        description={
          <>
            {`${w.hours} h local day in ${report.timezone}, ${formatLocal(report.windowStart, report.timezone)} to ${formatLocal(report.windowEnd, report.timezone)}`}
            {report.scheduleName ? ` · ${report.scheduleName}` : ''}
            {report.late ? ' · generated late' : ''}
          </>
        }
        action={
          canManage ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                setError(null);
                try {
                  await onRegenerate();
                  setQueued(true);
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              Regenerate
            </Button>
          ) : undefined
        }
      />
      {error ? <Alert>{error}</Alert> : null}
      {queued ? (
        <Alert tone="info">A new version is being generated; it appears in the history shortly.</Alert>
      ) : null}

      <section aria-label="Summary" className="rounded-[20px] border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatusPill tone={d.status.tone}>{d.status.label}</StatusPill>
          {report.narrativeStatus === 'verified' ? (
            <span className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
              Checked against the data
            </span>
          ) : null}
        </div>
        <p className="mt-4 max-w-3xl text-[17px] leading-7">{d.summary}</p>
        {report.narrativeStatus === 'deferred' ? (
          <div className="mt-3 text-xs text-muted-foreground">
            <p>
              The AI summary could not be checked against the data, so this one is written from the numbers.
            </p>
            {report.problems.length ? (
              <ul className="mt-1 list-disc pl-5">
                {report.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      {d.story.length ? (
        <section aria-label="Yesterday" className="rounded-[20px] border border-border bg-card px-6 py-5">
          <Eyebrow>Yesterday</Eyebrow>
          <ul className="mt-2 divide-y divide-border">
            {d.story.map((l) => (
              <li key={l.kind + l.text} className="flex items-start gap-3 py-2.5 text-[15px] leading-6">
                <span
                  aria-hidden
                  className={cn('mt-2.5 size-2 shrink-0 rounded-full', {
                    'bg-success': l.tone === 'good',
                    'bg-warning': l.tone === 'watch',
                    'bg-destructive': l.tone === 'attention',
                    'bg-foreground/25': l.tone === 'neutral',
                  })}
                />
                {l.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.kpis.length ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {d.kpis.map((k) => (
            <KpiCard key={k.key} kpi={k} />
          ))}
        </div>
      ) : null}

      {d.watch.length ? (
        <div className="space-y-3">
          <h2 className="px-1 text-sm font-semibold text-muted-foreground">Worth a look</h2>
          {d.watch.map((x) => (
            <section
              key={x.title}
              aria-label={x.title}
              className="flex items-start justify-between gap-4 rounded-[20px] border border-border bg-card p-5"
            >
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold">{x.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{x.text}</p>
              </div>
              <StatusPill tone={x.tone}>{x.tone === 'attention' ? 'Urgent' : 'Check'}</StatusPill>
            </section>
          ))}
        </div>
      ) : null}

      <Group
        title={
          d.hosts.length && d.websites.length
            ? 'Servers and websites'
            : d.hosts.length
              ? 'Servers'
              : 'Websites'
        }
      >
        {d.hosts.map((h) => (
          <Panel key={h.name} title={h.name} subtitle={h.subtitle} status={h}>
            {h.bars.map((b) => (
              <div key={b.label} className="mt-3">
                <div className="flex justify-between text-[13px]">
                  <span>{b.label}</span>
                  <span className="text-muted-foreground">{b.detail}</span>
                </div>
                <Meter percent={b.percent} />
              </div>
            ))}
          </Panel>
        ))}
        {d.websites.map((s) => (
          <Panel key={s.name} title={s.name} subtitle={s.subtitle} status={s}>
            <UptimeStrip hourly={s.hourly} />
            <Rows rows={s.rows} />
          </Panel>
        ))}
      </Group>
      <Group title="Google">
        {d.analytics.map((a) => (
          <Panel key={a.name} title={a.name} subtitle={a.subtitle} status={a}>
            <Compare compare={a.compare} />
            <Rows rows={a.rows} />
          </Panel>
        ))}
      </Group>
      <Group title={d.activity.length ? 'Databases and activity' : 'Databases'}>
        {d.databases.map((c) => (
          <Panel key={c.name} title={c.name} subtitle={c.subtitle} status={c}>
            <Rows rows={c.rows} />
          </Panel>
        ))}
        {d.activity.map((c) => (
          <Panel key={c.name} title={c.name} subtitle={c.subtitle} status={c}>
            <Rows rows={c.rows} />
          </Panel>
        ))}
      </Group>

      {d.notConnected.length || d.quiet.length ? (
        <section aria-label="Not connected yet" className="rounded-[20px] border border-border bg-card p-6">
          {d.notConnected.length ? (
            <>
              <h3 className="text-base font-semibold">Not connected yet</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {d.notConnected.map((n) => (
                  <span key={n} className="rounded-full border border-border px-3 py-1 text-xs">
                    {n}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Connect these in Integrations to see them in the next report.
              </p>
            </>
          ) : null}
          {d.quiet.length ? (
            <p className="mt-2 text-xs text-muted-foreground">No activity yesterday: {d.quiet.join(', ')}.</p>
          ) : null}
        </section>
      ) : null}

      <details className="group rounded-[20px] border border-border bg-card">
        <summary className="cursor-pointer list-none px-6 py-4 text-sm font-semibold">
          Show all numbers <span className="text-muted-foreground group-open:hidden">↓</span>
        </summary>
        <div className="space-y-3 px-4 pb-4">
          <section
            aria-label="Executive summary"
            className="space-y-2 rounded-2xl border border-border bg-card p-4 text-sm"
          >
            <h3 className="text-sm font-semibold">
              Executive summary{' '}
              {report.narrativeStatus === 'verified' ? (
                <Badge className="border-success/40 text-success">Verified against the data</Badge>
              ) : null}
            </h3>
            {report.narrative ? (
              <Cited text={report.narrative} />
            ) : report.narrativeStatus === 'deferred' ? (
              <p>Narrative deferred: the AI summary could not be verified against the data.</p>
            ) : (
              <p>AI summary is turned off; the figures below are complete.</p>
            )}
            {summary ? <p className="text-muted-foreground">{sectionLines(summary).join(' ')}</p> : null}
          </section>
          {report.snapshot.sections
            .filter((s) => s.key !== 'summary')
            .map((s) => (
              <SectionBlock key={s.id} section={s} />
            ))}
        </div>
      </details>

      <details className="group rounded-[20px] border border-border bg-card">
        <summary className="cursor-pointer list-none px-6 py-4 text-sm font-semibold">
          Delivery log{' '}
          <span className="font-normal text-muted-foreground">
            {`· ${sent} sent${failed ? `, ${failed} failed` : ''}`}
          </span>
        </summary>
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">To</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Attempts</th>
                <th className="px-4 py-2 font-medium">Last error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.deliveries.map((x) => (
                <tr key={x.id} aria-label={x.target}>
                  <td className="px-6 py-2">{x.target}</td>
                  <td className="px-4 py-2 capitalize">{x.kind}</td>
                  <td className="px-4 py-2">
                    <Badge
                      className={
                        x.status === 'sent'
                          ? 'border-success/40 text-success'
                          : x.status === 'dead'
                            ? 'border-destructive/40 text-destructive'
                            : undefined
                      }
                    >
                      {DELIVERY[x.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-2">{x.attempts}</td>
                  <td className="px-4 py-2 text-muted-foreground">{x.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
