'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatLocal, formatUtcTime } from './format';
import type { ChannelOption } from './schedule-dialog';

export interface ScheduleRow {
  id: string;
  name: string;
  timezone: string;
  localTime: string;
  channelIds: string[];
  recipients: string[];
  enabled: boolean;
  nextRunAt: string;
}

/** Report schedules (UC-15-01): when, where to, and the next run in local time and UTC. */
export function ScheduleList({
  schedules,
  channels,
  canManage,
  onRun,
  onToggle,
  onDelete,
}: {
  schedules: ScheduleRow[];
  channels: ChannelOption[];
  canManage: boolean;
  onRun: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const names = new Map(channels.map((c) => [c.id, c.name]));
  if (schedules.length === 0)
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        No report schedules yet. Add one to get a daily summary of the previous day by email, Slack, or
        webhook.
      </p>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Schedule</th>
            <th className="px-4 py-2 font-medium">When</th>
            <th className="px-4 py-2 font-medium">Sends to</th>
            <th className="px-4 py-2 font-medium">Next run</th>
            <th className="px-4 py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {schedules.map((s) => (
            <tr key={s.id} aria-label={s.name}>
              <td className="px-4 py-2 font-medium">
                {s.name}
                {s.enabled ? null : <Badge className="ml-2">Paused</Badge>}
              </td>
              <td className="px-4 py-2">{`${s.localTime} ${s.timezone}`}</td>
              <td className="px-4 py-2 text-muted-foreground">
                {[...s.channelIds.map((id) => names.get(id) ?? 'Deleted channel'), ...s.recipients].join(
                  ', ',
                )}
              </td>
              <td className="px-4 py-2 text-muted-foreground">
                {s.enabled
                  ? `${formatLocal(s.nextRunAt, s.timezone)} (${formatUtcTime(s.nextRunAt)} UTC)`
                  : '—'}
              </td>
              <td className="px-4 py-2 text-right">
                {canManage ? (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => onRun(s.id)}>
                      Run now
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onToggle(s.id, !s.enabled)}>
                      {s.enabled ? 'Pause' : 'Resume'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onDelete(s.id)}>
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
