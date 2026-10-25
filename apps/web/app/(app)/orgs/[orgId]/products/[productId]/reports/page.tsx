'use client';

import { PageHeading } from '@/components/shell/page-heading';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import Link from 'next/link';
import { ReportHistory } from '@/components/reports/report-toolbar';
import { formatLocal, formatUtcTime, NARRATIVE_LABEL } from '@/components/reports/format';
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

  const latest = reports.data?.reports[0];
  const next = [...(schedules.data?.schedules ?? [])]
    .filter((s) => s.enabled)
    .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0];
  return (
    <div className="portal-route portal-route-reports space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading
          eyebrow="Product operations"
          title="Reports & schedules"
          description="A clear daily picture, delivered on your schedule. Health, changes, and evidence in one place."
        />
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
      <div className="portal-report-overview">
        <article className="portal-feature-card">
          <p className="portal-eyebrow">Latest report</p>
          <h2>{latest ? latest.localDate : 'Your first report starts here'}</h2>
          <p className="text-sm text-muted-foreground">
            {latest
              ? NARRATIVE_LABEL[latest.narrativeStatus]
              : 'Create a schedule or run an existing one to receive a product summary.'}
          </p>
          {latest && (
            <div className="portal-feature-footer">
              <span>
                Version {latest.version} · {latest.scheduleName ?? 'Deleted schedule'}
              </span>
              <Link href={`/orgs/${orgId}/products/${productId}/reports/${latest.id}`}>Read report ↗</Link>
            </div>
          )}
        </article>
        <article className="portal-feature-card">
          <p className="portal-eyebrow">Next delivery</p>
          <h2>{next ? next.localTime : 'No delivery scheduled'}</h2>
          <p className="text-sm text-muted-foreground">
            {next ? next.timezone : 'Paused schedules do not create new reports.'}
          </p>
          {next && (
            <div className="portal-feature-footer">
              <span>
                {formatLocal(next.nextRunAt, next.timezone)} · {formatUtcTime(next.nextRunAt)} UTC
              </span>
            </div>
          )}
        </article>
      </div>
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
          <ReportHistory
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
