'use client';

import { PageHeading } from '@/components/shell/page-heading';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';
import { ApiError, unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { AiSettingsCard } from '@/components/ai/ai-settings-card';
import { DeleteOrganization, ExportCard } from '@/components/orgs/tenant-data';
import { SimpleForm } from '@/components/auth/simple-form';
import { Loading } from '@/components/states/loading';
import { NotFoundState } from '@/components/states/not-found-state';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  timezone: z.string().min(1, 'Enter a timezone'),
  dataRetentionDays: z.coerce.number().int().min(1, 'At least 1 day').max(3650),
});

export default function SettingsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const ai = useApiQuery(['ai-settings', orgId], async () =>
    unwrap(await api.GET('/api/v1/organizations/{orgId}/settings/ai', { params: { path: { orgId } } })),
  );
  const [saved, setSaved] = useState(false);
  const isOwner = roleCan((org.data?.role ?? 'viewer') as Role, 'org.export');
  const exports = useApiQuery(
    ['org-exports', orgId],
    async () =>
      unwrap(await api.GET('/api/v1/organizations/{orgId}/export', { params: { path: { orgId } } })).exports,
    {
      enabled: isOwner,
      refetchInterval: (q) => (q.state.data?.some((e) => e.status === 'queued') ? 3000 : false),
    },
  );
  if (org.visibleError instanceof ApiError && org.visibleError.status === 404) return <NotFoundState />;
  if (!org.data) return <Loading label="Loading settings" />;
  // Settings require org.settings.manage; others get the same page as a missing one.
  if (!roleCan(org.data.role as Role, 'org.settings.manage')) return <NotFoundState />;
  const settings = (org.data.settings ?? {}) as { dataRetentionDays?: number };
  return (
    <section className="max-w-lg space-y-3">
      <PageHeading
        title={<>Settings</>}
        description="Workspace identity, AI preferences, and data controls."
        eyebrow="Workspace"
      />
      {saved ? <Alert tone="success">Settings saved.</Alert> : null}
      <Card>
        <SimpleForm
          schema={schema}
          defaults={{
            name: org.data.name,
            timezone: org.data.timezone,
            dataRetentionDays: settings.dataRetentionDays ?? 90,
          }}
          fields={[
            { name: 'name', label: 'Organization name' },
            { name: 'timezone', label: 'Timezone', hint: 'IANA name, e.g. Europe/Berlin' },
            { name: 'dataRetentionDays', label: 'Data retention (days)', type: 'number' },
          ]}
          submitLabel="Save settings"
          pendingLabel="Saving…"
          onSubmit={async (v) => {
            setSaved(false);
            unwrap(
              await api.PATCH('/api/v1/organizations/{orgId}/settings', {
                params: { path: { orgId } },
                body: {
                  name: v.name,
                  timezone: v.timezone,
                  settings: { dataRetentionDays: v.dataRetentionDays },
                },
              }),
            );
            await queryClient.invalidateQueries({ queryKey: ['org', orgId] });
            setSaved(true);
          }}
        />
      </Card>
      {ai.data ? (
        <AiSettingsCard
          settings={ai.data}
          onChange={async (disabled) => {
            unwrap(
              await api.PATCH('/api/v1/organizations/{orgId}/settings/ai', {
                params: { path: { orgId } },
                body: { disabled },
              }),
            );
            await queryClient.invalidateQueries({ queryKey: ['ai-settings', orgId] });
          }}
        />
      ) : null}
      {isOwner ? (
        <>
          <ExportCard
            exports={exports.data ?? []}
            downloadHref={(id) => `/api/v1/organizations/${orgId}/export/${id}/download`}
            onExport={async () => {
              unwrap(await api.POST('/api/v1/organizations/{orgId}/export', { params: { path: { orgId } } }));
              await queryClient.invalidateQueries({ queryKey: ['org-exports', orgId] });
            }}
          />
          {org.data.deletionScheduledFor ? null : (
            <DeleteOrganization
              name={org.data.name}
              onDelete={async (confirmName) => {
                unwrap(
                  await api.DELETE('/api/v1/organizations/{orgId}', {
                    params: { path: { orgId } },
                    body: { confirmName },
                  }),
                );
                await queryClient.invalidateQueries({ queryKey: ['org', orgId] });
              }}
            />
          )}
        </>
      ) : null}
    </section>
  );
}
