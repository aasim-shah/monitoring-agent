'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface ChannelRow {
  id: string;
  name: string;
  kind: 'email' | 'slack' | 'webhook';
  recipients: string[] | null;
  target: string | null;
  escalation: boolean;
  status: 'active' | 'broken';
}

const KIND = { email: 'Email', slack: 'Slack', webhook: 'Webhook' } as const;

/** Notification channels (UC-13-09); URLs and secrets are never shown, only the target host. */
export function ChannelList({
  channels,
  canManage,
  onTest,
  onDelete,
}: {
  channels: ChannelRow[];
  canManage: boolean;
  onTest: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  if (channels.length === 0)
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        No notification channels yet. Incidents still appear in the dashboard; add a channel to be told.
      </p>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Channel</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Sends to</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {channels.map((c) => (
            <tr key={c.id} aria-label={c.name}>
              <td className="px-4 py-2 font-medium">
                {c.name}
                {c.escalation ? (
                  <span className="ml-2 text-xs text-muted-foreground">escalations</span>
                ) : null}
              </td>
              <td className="px-4 py-2">{KIND[c.kind]}</td>
              <td className="px-4 py-2 text-muted-foreground">{c.recipients?.join(', ') ?? c.target}</td>
              <td className="px-4 py-2">
                {c.status === 'broken' ? (
                  <Badge className="border-destructive/40 text-destructive">Broken</Badge>
                ) : (
                  <Badge className="border-success/40 text-success">Active</Badge>
                )}
              </td>
              <td className="px-4 py-2 text-right">
                {canManage ? (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => onTest(c.id)}>
                      Send test
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onDelete(c.id)}>
                      Delete
                    </Button>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
