'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { ReportList } from '@/components/reports/report-list';
import { ScheduleDialog, type ChannelOption, type NewSchedule } from '@/components/reports/schedule-dialog';
import { ScheduleList } from '@/components/reports/schedule-list';
import { Alert } from '@/components/ui/alert';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

export default function ReportsPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const canManage = roleCan(role, 'report.manage');
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const schedules = useApiQuery(['report-schedules', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{id}/report-schedules', { params: { path: { id: productId } } })),
  );
  const reports = useApiQuery(
    ['reports', productId],
    async () =>
      unwrap(await api.GET('/api/v1/products/{id}/reports', { params: { path: { id: productId } } })),
    { refetchInterval: 15_000 },
  );
  // Channels are organization settings; members who cannot list them still see names as "channel".
  const channels = useApiQuery(['notification-channels', orgId], async () => {
    const res = await api.GET('/api/v1/organizations/{orgId}/notification-channels', {
      params: { path: { orgId } },
    });
    return res.data
      ? res.data.channels.map((c): ChannelOption => ({ id: c.id, name: c.name, kind: c.kind }))
      : [];
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['report-schedules', productId] }),
      queryClient.invalidateQueries({ queryKey: ['reports', productId] }),
    ]);
  const run = async (f: () => Promise<unknown>, done?: string) => {
    setMessage(null);
    try {
      await f();
      await refresh();
      if (done) setMessage({ tone: 'info', text: done });
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    }
  };
  const preview = useCallback(
    async (timezone: string, localTime: string) =>
      unwrap(
        await api.GET('/api/v1/products/{id}/report-schedules/preview', {
          params: { path: { id: productId }, query: { timezone, localTime } },
        }),
      ),
    [productId],
  );
  const create = async (input: NewSchedule) => {
    unwrap(await api.POST('/api/v1/report-schedules', { body: { productId, ...input } }));
    await refresh();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reports & Schedules</h1>
          <p className="text-sm text-muted-foreground">
            A daily report of the previous local day: incidents, hosts, logs, databases, and websites, with a
            summary checked against the numbers. Missing sources are listed, never shown as zero.
          </p>
        </div>
        {canManage ? (
          <ScheduleDialog
            channels={channels.data ?? []}
            defaultTimezone={org.data?.timezone ?? 'UTC'}
            onPreview={preview}
            onSubmit={create}
          />
        ) : null}
      </div>
      {message ? <Alert tone={message.tone === 'info' ? 'info' : undefined}>{message.text}</Alert> : null}
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Schedules</h2>
        <QueryState query={schedules} label="Loading schedules">
          <ScheduleList
            schedules={(schedules.data?.schedules ?? []).map((s) => ({
              id: s.id,
              name: s.name,
              timezone: s.timezone,
              localTime: s.localTime,
              channelIds: s.channelIds,
              recipients: s.recipients,
              enabled: s.enabled,
              nextRunAt: s.nextRunAt,
            }))}
            channels={channels.data ?? []}
            canManage={canManage}
            onRun={(id) =>
              run(
                async () =>
                  unwrap(await api.POST('/api/v1/report-schedules/{id}/run', { params: { path: { id } } })),
                'Report queued; it appears below within a minute.',
              )
            }
            onToggle={(id, enabled) =>
              run(async () =>
                unwrap(
                  await api.PATCH('/api/v1/report-schedules/{id}', {
                    params: { path: { id } },
                    body: { enabled },
                  }),
                ),
              )
            }
            onDelete={(id) =>
              run(async () =>
                unwrap(await api.DELETE('/api/v1/report-schedules/{id}', { params: { path: { id } } })),
              )
            }
          />
        </QueryState>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Report history</h2>
        <QueryState query={reports} label="Loading reports">
          <ReportList
            reports={(reports.data?.reports ?? []).map((r) => ({
              id: r.id,
              localDate: r.localDate,
              version: r.version,
              narrativeStatus: r.narrativeStatus,
              late: r.late,
              scheduleName: r.scheduleName ?? null,
              createdAt: r.createdAt,
            }))}
            href={(id) => `/orgs/${orgId}/products/${productId}/reports/${id}`}
          />
        </QueryState>
      </section>
    </div>
  );
}
