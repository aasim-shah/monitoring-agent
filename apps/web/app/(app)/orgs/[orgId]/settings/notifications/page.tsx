'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApiError, unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { AddChannelDialog } from '@/components/alerting/add-channel-dialog';
import { ChannelList, type ChannelRow } from '@/components/alerting/channel-list';
import { Loading } from '@/components/states/loading';
import { NotFoundState } from '@/components/states/not-found-state';
import { Alert } from '@/components/ui/alert';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

export default function NotificationChannelsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const key = ['notification-channels', orgId];
  const channels = useApiQuery(key, async () =>
    unwrap(
      await api.GET('/api/v1/organizations/{orgId}/notification-channels', { params: { path: { orgId } } }),
    ),
  );
  if (org.visibleError instanceof ApiError && org.visibleError.status === 404) return <NotFoundState />;
  if (!org.data) return <Loading label="Loading notification channels" />;
  const canManage = roleCan(org.data.role as Role, 'org.settings.manage');
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Notification channels</h1>
          <p className="text-sm text-muted-foreground">
            Incidents notify every active channel at most once per 30 minutes per incident.
          </p>
        </div>
        {canManage ? (
          <AddChannelDialog
            onSubmit={async (body) => {
              const created = unwrap(
                await api.POST('/api/v1/organizations/{orgId}/notification-channels', {
                  params: { path: { orgId } },
                  body,
                }),
              );
              await refresh();
              return { signingSecret: (created as { signingSecret?: string }).signingSecret };
            }}
          />
        ) : null}
      </div>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <QueryState query={channels} label="Loading notification channels">
        <ChannelList
          channels={(channels.data?.channels ?? []) as ChannelRow[]}
          canManage={canManage}
          onTest={async (id) => {
            try {
              unwrap(await api.POST('/api/v1/notification-channels/{id}/test', { params: { path: { id } } }));
              setMessage({ tone: 'success', text: 'Test notification queued; it arrives within a minute.' });
            } catch (e) {
              setMessage({ tone: 'error', text: errorMessage(e) });
            }
          }}
          onDelete={async (id) => {
            try {
              unwrap(await api.DELETE('/api/v1/notification-channels/{id}', { params: { path: { id } } }));
              await refresh();
            } catch (e) {
              setMessage({ tone: 'error', text: errorMessage(e) });
            }
          }}
        />
      </QueryState>
    </section>
  );
}
