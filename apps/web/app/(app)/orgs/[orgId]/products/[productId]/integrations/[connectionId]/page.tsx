'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { ConnectionDetail } from '@/components/integrations/connection-detail';
import { GoogleAccess } from '@/components/integrations/google-access';
import { Alert } from '@/components/ui/alert';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

export default function IntegrationDetailPage() {
  const { orgId, productId, connectionId } = useParams<{
    orgId: string;
    productId: string;
    connectionId: string;
  }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const path = { params: { path: { id: connectionId } } };
  const key = ['integration', connectionId];
  const detail = useApiQuery(
    key,
    async () => {
      const [connection, inventory, deliveries, events, runs, health, catalog] = await Promise.all([
        api.GET('/api/v1/connections/{id}', path).then(unwrap),
        api.GET('/api/v1/connections/{id}/inventory', path).then(unwrap),
        api.GET('/api/v1/connections/{id}/webhook-deliveries', path).then(unwrap),
        api.GET('/api/v1/connections/{id}/change-events', path).then(unwrap),
        api.GET('/api/v1/connections/{id}/sync-runs', path).then(unwrap),
        api.GET('/api/v1/connections/{id}/health', path).then(unwrap),
        api.GET('/api/v1/connectors/catalog').then(unwrap),
      ]);
      const latest = health.latest as { data?: { missingPermissions?: string[] } | null } | null;
      return {
        connection: {
          ...connection,
          missingPermissions: latest?.data?.missingPermissions ?? [],
        },
        productId,
        webhookUrl: `${window.location.origin}/webhooks/${connection.provider}/${connection.id}`,
        inventory: inventory.items,
        deliveries: deliveries.deliveries,
        events: events.events,
        runs: runs.runs,
        credentialFields: catalog.connectors.find((c) => c.type === connection.provider)?.credentialFields,
      };
    },
    {
      refetchInterval: (q) =>
        q.state.data?.connection.status === 'pending_validation' ||
        q.state.data?.runs.some((r) => r.status === 'queued' || r.status === 'running')
          ? 3000
          : 30_000,
    },
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  // Back from Google's consent screen (M13b).
  const googleResult = useSearchParams().get('google');
  const GOOGLE_RESULT: Record<string, { tone: 'success' | 'info' | 'error'; text: string }> = {
    connected: { tone: 'success', text: 'Google access saved. Validation and discovery start now.' },
    cancelled: { tone: 'info', text: 'Google consent was cancelled; nothing was changed.' },
    error: { tone: 'error', text: 'Google did not accept the sign-in. Try again.' },
  };

  return (
    <QueryState query={detail} label="Loading integration">
      {googleResult && GOOGLE_RESULT[googleResult] ? (
        <Alert tone={GOOGLE_RESULT[googleResult]!.tone} className="mb-4">
          {GOOGLE_RESULT[googleResult]!.text}
        </Alert>
      ) : null}
      {detail.data?.connection.provider === 'google' ? (
        <div className="mb-4">
          <GoogleAccess
            accountEmail={detail.data.connection.accountEmail ?? null}
            grantedScopes={detail.data.connection.grantedScopes ?? []}
            canConfigure={roleCan(role, 'connection.configure')}
            onGrant={async () => {
              const { url } = unwrap(
                await api.POST('/api/v1/connections/{id}/oauth/google/start', {
                  ...path,
                  body: { productId, missingOnly: true },
                }),
              );
              window.location.assign(url);
            }}
          />
        </div>
      ) : null}
      {detail.data ? (
        <ConnectionDetail
          data={detail.data}
          canConfigure={roleCan(role, 'connection.configure')}
          onScope={async (scopes) => {
            unwrap(
              await api.POST('/api/v1/connections/{id}/resource-scopes', {
                ...path,
                body: {
                  scopes: scopes.map((s) => ({
                    externalId: s.externalId,
                    resourceType: s.resourceType,
                    name: s.name,
                    productId: s.productId,
                    ...(s.environmentId ? { environmentId: s.environmentId } : {}),
                  })),
                },
              }),
            );
            await refresh();
          }}
          actions={{
            onValidate: async () => {
              unwrap(await api.POST('/api/v1/connections/{id}/validate', path));
              await refresh();
            },
            onDiscover: async () => {
              unwrap(await api.POST('/api/v1/connections/{id}/discover', path));
              await refresh();
            },
            onDelete: async () => {
              unwrap(await api.DELETE('/api/v1/connections/{id}', path));
              router.push(`/orgs/${orgId}/products/${productId}/integrations`);
            },
            onReplaceCredentials: async (credentials) => {
              unwrap(
                await api.POST('/api/v1/connections/{id}/authorize', { ...path, body: { credentials } }),
              );
              await refresh();
            },
          }}
        />
      ) : null}
    </QueryState>
  );
}
