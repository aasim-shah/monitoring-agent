'use client';

import { Fragment, useState } from 'react';
import { sectionLines, type Section, type Snapshot } from '@pcp/reports/render';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
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
      className="space-y-1 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">
        {section.title} <span className="text-xs font-normal text-muted-foreground">{section.id}</span>
      </h2>
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

/** One report version (UC-15-04/06): validated summary, the 12 sections, and the delivery log. */
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
  const summary = report.snapshot.sections.find((s) => s.key === 'summary');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{`Daily report — ${report.localDate} · v${report.version}`}</h1>
          <p className="text-sm text-muted-foreground">
            {`${w.hours} h local day in ${report.timezone}, ${formatLocal(report.windowStart, report.timezone)} to ${formatLocal(report.windowEnd, report.timezone)}`}
            {report.scheduleName ? ` · ${report.scheduleName}` : ''}
            {report.late ? ' · generated late' : ''}
          </p>
        </div>
        {canManage ? (
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
        ) : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {queued ? (
        <Alert tone="info">A new version is being generated; it appears in the history shortly.</Alert>
      ) : null}

      <section
        aria-label="Executive summary"
        className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm"
      >
        <h2 className="text-sm font-semibold">
          Executive summary{' '}
          {report.narrativeStatus === 'verified' ? (
            <Badge className="border-success/40 text-success">Verified against the data</Badge>
          ) : null}
        </h2>
        {report.narrative ? (
          <Cited text={report.narrative} />
        ) : report.narrativeStatus === 'deferred' ? (
          <>
            <p>Narrative deferred: the AI summary could not be verified against the data.</p>
            {report.problems.length ? (
              <ul className="list-disc pl-5 text-muted-foreground">
                {report.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </>
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

      <section aria-label="Delivery log" className="space-y-2">
        <h2 className="text-sm font-semibold">Delivery log</h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">To</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Attempts</th>
                <th className="px-4 py-2 font-medium">Last error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.deliveries.map((d) => (
                <tr key={d.id} aria-label={d.target}>
                  <td className="px-4 py-2">{d.target}</td>
                  <td className="px-4 py-2 capitalize">{d.kind}</td>
                  <td className="px-4 py-2">
                    <Badge
                      className={
                        d.status === 'sent'
                          ? 'border-success/40 text-success'
                          : d.status === 'dead'
                            ? 'border-destructive/40 text-destructive'
                            : undefined
                      }
                    >
                      {DELIVERY[d.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-2">{d.attempts}</td>
                  <td className="px-4 py-2 text-muted-foreground">{d.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
