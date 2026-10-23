'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { formatValue } from '@/lib/format';

export interface MonitorRow {
  id: string;
  url: string;
  host: string;
  intervalSeconds: number;
  status: 'pending_verification' | 'active' | 'paused';
  pausedReason: string | null;
  verification: { record: 'TXT'; name: string; value: string };
  last: {
    checkedAt: string;
    up: boolean | null;
    statusCode: number | null;
    error: string | null;
    totalMs: number | null;
    consecutiveFailures: number;
  } | null;
  tls: { expiresAt: string; issuer: string | null } | null;
}

type VerifyResult = { verified: boolean; checkedNames: string[] };

function state(m: MonitorRow) {
  if (m.status === 'paused') return <Badge>Paused</Badge>;
  if (m.status === 'pending_verification')
    return <Badge className="border-warning/40 text-warning">Verifying</Badge>;
  if (!m.last) return <Badge>Waiting for first check</Badge>;
  return m.last.up ? (
    <Badge className="border-success/40 text-success">Up</Badge>
  ) : (
    <Badge className="border-destructive/40 text-destructive">Down</Badge>
  );
}

function ago(iso: string, now: Date) {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function tlsDays(m: MonitorRow, now: Date) {
  if (!m.tls) return '—';
  const days = Math.floor((new Date(m.tls.expiresAt).getTime() - now.getTime()) / 86_400_000);
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Website monitors (WB-09 §7). Unverified and paused monitors show the TXT record that proves
 * control of the domain; nothing is probed until it is found (BR-09-01).
 */
export function MonitorList({
  monitors,
  canManage,
  now,
  selected,
  onSelect,
  onVerify,
  onDelete,
}: {
  monitors: MonitorRow[];
  canManage: boolean;
  now: Date;
  selected: string | null;
  onSelect: (id: string) => void;
  onVerify: (id: string) => Promise<VerifyResult>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [checks, setChecks] = useState<Record<string, string>>({});
  const verify = async (id: string) => {
    setChecks((c) => ({ ...c, [id]: 'Checking…' }));
    try {
      const r = await onVerify(id);
      setChecks((c) => ({
        ...c,
        [id]: r.verified
          ? 'Verified. The first check runs within a minute.'
          : `Not found yet on ${r.checkedNames.join(', ')}. DNS changes can take a few minutes.`,
      }));
    } catch (e) {
      setChecks((c) => ({ ...c, [id]: errorMessage(e) }));
    }
  };

  if (monitors.length === 0)
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        No websites or APIs monitored yet. Add a URL to check its status, response time, and certificate.
      </p>
    );
  const unverified = monitors.filter((m) => m.status !== 'active');
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">URL</th>
              <th className="px-4 py-2 font-medium">State</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Response time</th>
              <th className="px-4 py-2 font-medium">Certificate expires in</th>
              <th className="px-4 py-2 font-medium">Last check</th>
              <th className="px-4 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {monitors.map((m) => (
              <tr key={m.id} aria-label={m.url} className={m.id === selected ? 'bg-muted/50' : undefined}>
                <td className="max-w-xs truncate px-4 py-2 font-medium">
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => onSelect(m.id)}
                  >
                    {m.url}
                  </button>
                </td>
                <td className="px-4 py-2">{state(m)}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  {m.last ? (m.last.statusCode ?? m.last.error ?? '—') : '—'}
                </td>
                <td className="px-4 py-2">
                  {m.last?.totalMs !== null && m.last?.totalMs !== undefined
                    ? formatValue(m.last.totalMs, 'ms')
                    : '—'}
                </td>
                <td className="px-4 py-2">{tlsDays(m, now)}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  {m.last ? ago(m.last.checkedAt, now) : '—'}
                </td>
                <td className="px-4 py-2 text-right">
                  {canManage ? (
                    <Button size="sm" variant="ghost" onClick={() => onDelete(m.id)}>
                      Delete
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unverified.map((m) => (
        <section
          key={m.id}
          aria-label={`Verify ${m.host}`}
          className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm"
        >
          <p className="font-medium">
            {m.status === 'paused'
              ? `Paused: ${m.pausedReason ?? 'domain not verified'}`
              : `Verify ${m.host}`}
          </p>
          <p className="text-muted-foreground">
            Add a TXT record on {m.verification.name} (or a parent domain) with this value, then check. We
            probe the site only after the record is found.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">
              {m.verification.value}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard?.writeText(m.verification.value)}
            >
              Copy value
            </Button>
            {canManage ? (
              <Button size="sm" onClick={() => verify(m.id)}>
                Check verification
              </Button>
            ) : null}
          </div>
          {checks[m.id] ? <p role="status">{checks[m.id]}</p> : null}
        </section>
      ))}
    </div>
  );
}
