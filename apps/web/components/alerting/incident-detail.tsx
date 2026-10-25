'use client';

import { PageHeading } from '@/components/shell/page-heading';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { SeverityBadge, StatusBadge, when, type IncidentStatus, type Severity } from './labels';

type Impact = 'confirmed' | 'potential' | 'unknown';

export interface IncidentDetailData {
  incident: {
    id: string;
    title: string;
    severity: Severity;
    status: IncidentStatus;
    summary: string;
    startedAt: string;
    acknowledgedAt: string | null;
    resolvedAt: string | null;
    resolutionNote: string | null;
    postmortem: { summary?: string; causeCategory?: string; followUps?: string[] } | null;
  };
  events: Array<{ kind: string; at: string; detail?: Record<string, unknown> }>;
  correlation: {
    host: { id: string; name: string } | null;
    assets: Array<{ assetId: string; name: string; assetType: string; impact: Impact; distance: number }>;
    counts: Record<string, number>;
  };
  changes: unknown[];
  sourceLinks: Array<{ label: string; href: string }>;
}

const CAUSES = [
  'capacity',
  'deployment',
  'configuration',
  'dependency',
  'infrastructure',
  'code',
  'other',
] as const;
export type CauseCategory = (typeof CAUSES)[number];

export interface PostmortemInput {
  summary: string;
  causeCategory: CauseCategory;
  followUps: string[];
}

const IMPACT: Record<Impact, { label: string; className: string }> = {
  confirmed: { label: 'Confirmed', className: 'border-destructive/40 text-destructive' },
  potential: { label: 'Potential', className: 'border-warning/40 text-warning' },
  unknown: { label: 'Unknown', className: '' },
};

/** Timeline wording; every entry is something that happened, never a guessed cause. */
function describe(e: IncidentDetailData['events'][number]): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'fired':
      return d.value ? `Alert fired (value ${String(d.value)})` : 'Alert fired';
    case 'refired':
      return 'Still firing';
    case 'reopened':
      return 'Fired again; incident reopened';
    case 'acknowledged':
      return 'Acknowledged';
    case 'resolved':
      return d.by === 'user'
        ? `Resolved by a member${d.note ? `: ${String(d.note)}` : ''}`
        : 'Condition cleared';
    case 'notified':
      return `Notified: ${String(d.event ?? '')}`;
    case 'suppressed':
      return 'Notification suppressed (30-minute cooldown)';
    case 'escalated':
      return 'Escalated: unacknowledged for 15 min';
    default:
      return e.kind;
  }
}

const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';
const textareaClass = 'min-h-20 w-full rounded-md border border-border bg-background p-2 text-sm';

/** Incident detail (WB-13 §8, Scenario B steps 3 and 6). */
export function IncidentDetail({
  data,
  canManage,
  onAcknowledge,
  onResolve,
  onPostmortem,
  askAiHref,
}: {
  data: IncidentDetailData;
  /** Set when AI is on and the member has `ai.use`. */
  askAiHref?: string;
  canManage: boolean;
  onAcknowledge: () => Promise<void>;
  onResolve: (note: string) => Promise<void>;
  onPostmortem: (p: PostmortemInput) => Promise<void>;
}) {
  const { incident, events, correlation, sourceLinks } = data;
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pm = incident.postmortem ?? {};
  const [pmSummary, setPmSummary] = useState(pm.summary ?? '');
  const [pmCause, setPmCause] = useState<CauseCategory>((pm.causeCategory as CauseCategory) ?? 'other');
  const [pmFollowUps, setPmFollowUps] = useState((pm.followUps ?? []).join('\n'));
  const [saved, setSaved] = useState(false);

  const act = async (fn: () => Promise<void>) => {
    setError(null);
    setPending(true);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="portal-feature-section space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={incident.severity} />
        <StatusBadge status={incident.status} />
        <PageHeading title={<>{incident.title}</>} eyebrow="Product detail" />
        {askAiHref ? (
          <Link
            className="ml-auto rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            href={askAiHref}
          >
            Ask AI
          </Link>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">Started {when(incident.startedAt)}</p>
      {error ? <Alert>{error}</Alert> : null}
      <Card className="space-y-2">
        <CardTitle>Summary</CardTitle>
        <p className="text-sm">{incident.summary}</p>
        {incident.status === 'resolved' && incident.resolutionNote ? (
          <p className="text-sm text-muted-foreground">Resolution: {incident.resolutionNote}</p>
        ) : null}
      </Card>

      {canManage && incident.status !== 'resolved' ? (
        <Card className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {incident.status === 'open' ? (
              <Button disabled={pending} onClick={() => act(onAcknowledge)}>
                Acknowledge
              </Button>
            ) : null}
          </div>
          <Field id="resolution-note" label="Resolution note">
            <textarea
              id="resolution-note"
              className={textareaClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <Button variant="outline" disabled={pending} onClick={() => act(() => onResolve(note.trim()))}>
            Resolve
          </Button>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-2">
          <CardTitle>Timeline</CardTitle>
          <ol aria-label="Timeline" className="space-y-1 text-sm">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex gap-3">
                <span className="w-36 shrink-0 text-muted-foreground">{when(e.at)}</span>
                <span>{describe(e)}</span>
              </li>
            ))}
          </ol>
        </Card>
        <Card className="space-y-2">
          <CardTitle>Blast radius</CardTitle>
          {correlation.assets.length ? (
            <table aria-label="Blast radius" className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Asset</th>
                  <th className="py-1 font-medium">Type</th>
                  <th className="py-1 font-medium">Impact</th>
                </tr>
              </thead>
              <tbody>
                {correlation.assets.map((a) => (
                  <tr key={a.assetId} aria-label={a.name}>
                    <td className="py-1">{a.name}</td>
                    <td className="py-1 text-muted-foreground">{a.assetType}</td>
                    <td className="py-1">
                      <Badge className={cn(IMPACT[a.impact].className)}>{IMPACT[a.impact].label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">
              No related assets are known in the asset graph yet.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Potential means it depends on the affected asset; it is not proof of an outage.
          </p>
        </Card>
        <Card className="space-y-2">
          <CardTitle>Recent changes</CardTitle>
          <p className="text-sm text-muted-foreground">No recent changes recorded.</p>
        </Card>
        <Card className="space-y-2">
          <CardTitle>Sources</CardTitle>
          <ul className="space-y-1 text-sm">
            {sourceLinks.map((l) => (
              <li key={l.href}>
                <Link className="text-primary hover:underline" href={l.href}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {canManage ? (
        <Card className="space-y-3">
          <CardTitle>Postmortem</CardTitle>
          {saved ? <Alert tone="success">Postmortem saved.</Alert> : null}
          <Field id="pm-summary" label="What happened">
            <textarea
              id="pm-summary"
              className={textareaClass}
              value={pmSummary}
              onChange={(e) => setPmSummary(e.target.value)}
            />
          </Field>
          <Field id="pm-cause" label="Cause category">
            <select
              id="pm-cause"
              className={selectClass}
              value={pmCause}
              onChange={(e) => setPmCause(e.target.value as CauseCategory)}
            >
              {CAUSES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field id="pm-followups" label="Follow-ups (one per line)">
            <textarea
              id="pm-followups"
              className={textareaClass}
              value={pmFollowUps}
              onChange={(e) => setPmFollowUps(e.target.value)}
            />
          </Field>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              act(async () => {
                setSaved(false);
                await onPostmortem({
                  summary: pmSummary.trim(),
                  causeCategory: pmCause,
                  followUps: pmFollowUps
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean),
                });
                setSaved(true);
              })
            }
          >
            Save postmortem
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
