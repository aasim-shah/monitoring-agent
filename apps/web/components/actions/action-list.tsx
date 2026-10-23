'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import { describeAction, STATUS_LABEL, STATUS_TONE } from './format';

export interface ActionRow {
  id: string;
  capability: string;
  params: Record<string, unknown>;
  host: string | null;
  status: string;
  proposedByAi: boolean;
  requestedByUserId: string | null;
  production: boolean;
  impactSummary: string | null;
  createdAt: string;
}

/** Action requests (UC-16-05): pending ones with impact and decision buttons, then history. */
export function ActionList({
  actions,
  currentUserId,
  canApprove,
  href,
  onApprove,
  onReject,
}: {
  actions: ActionRow[];
  currentUserId: string | null;
  canApprove: boolean;
  href: (id: string) => string;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, note: string) => Promise<void>;
}) {
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (actions.length === 0)
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        No actions yet. Enable a policy, then propose a restart from here or let the AI assistant propose one.
      </p>
    );

  const confirmReject = async (id: string) => {
    if (!note.trim()) return setError('Say why');
    setError(null);
    try {
      await onReject(id, note.trim());
      setRejecting(null);
      setNote('');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Action</th>
            <th className="px-4 py-2 font-medium">State</th>
            <th className="px-4 py-2 font-medium">Impact</th>
            <th className="px-4 py-2 font-medium">
              <span className="sr-only">Decision</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {actions.map((a) => {
            const label = describeAction(a.capability, a.params, a.host);
            const pending = a.status === 'pending_approval';
            const ownProduction = a.production && a.requestedByUserId === currentUserId;
            return (
              <tr key={a.id} aria-label={label}>
                <td className="px-4 py-2 align-top">
                  <Link className="font-medium underline-offset-2 hover:underline" href={href(a.id)}>
                    {label}
                  </Link>
                  {a.proposedByAi ? <Badge className="ml-2">Proposed by AI</Badge> : null}
                  <div className="text-xs text-muted-foreground">
                    {new Date(a.createdAt).toLocaleString()}
                  </div>
                </td>
                <td className="px-4 py-2 align-top">
                  <Badge className={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
                </td>
                <td className="max-w-sm px-4 py-2 align-top text-muted-foreground">
                  {a.impactSummary ?? '—'}
                </td>
                <td className="px-4 py-2 text-right align-top">
                  {pending && canApprove ? (
                    ownProduction ? (
                      <span className="text-xs text-muted-foreground">Waiting for another approver</span>
                    ) : rejecting === a.id ? (
                      <div className="space-y-2 text-left">
                        {error ? <Alert>{error}</Alert> : null}
                        <Field id={`why-${a.id}`} label="Why">
                          <Input id={`why-${a.id}`} value={note} onChange={(e) => setNote(e.target.value)} />
                        </Field>
                        <Button size="sm" variant="outline" onClick={() => confirmReject(a.id)}>
                          Confirm rejection
                        </Button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => onApprove(a.id)}>
                          Approve
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRejecting(a.id)}>
                          Reject
                        </Button>
                      </div>
                    )
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
