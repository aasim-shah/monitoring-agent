'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { ConnectDialog, type NewIntegration } from '@/components/integrations/connect-dialog';
import { GoogleConnectDialog } from '@/components/integrations/google-connect';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { INTEGRATIONS, INTEGRATION_PROVIDERS, isIntegration } from '@/lib/integrations';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

export default function IntegrationsPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const router = useRouter();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const canConfigure = roleCan(role, 'connection.configure');
  const catalog = useApiQuery(['connector-catalog'], async () =>
    unwrap(await api.GET('/api/v1/connectors/catalog')),
  );
  const connections = useApiQuery(
    ['integrations', orgId, productId],
    async () =>
      unwrap(
        await api.GET('/api/v1/organizations/{orgId}/connections', { params: { path: { orgId } } }),
      ).connections.filter(
        (c) =>
          isIntegration(c.provider) &&
          c.status !== 'disconnected' &&
          // Scoped here, or not scoped to any product yet (visible to organization-wide members only).
          (c.scopes.length === 0 || c.scopes.some((s) => s.productId === productId)),
      ),
    {
      refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'pending_validation') ? 3000 : 30_000),
    },
  );
  const available = INTEGRATION_PROVIDERS.filter((p) =>
    (catalog.data?.connectors ?? []).some((c) => c.type === p),
  );

  const connect = async (input: NewIntegration) => {
    const created = unwrap(
      await api.POST('/api/v1/organizations/{orgId}/connections', {
        params: { path: { orgId } },
        body: {
          provider: input.provider,
          displayName: input.displayName,
          executionLocation: 'cloud',
          config: input.config,
        },
      }),
    );
    unwrap(
      await api.POST('/api/v1/connections/{id}/authorize', {
        params: { path: { id: created.id } },
        body: { credentials: input.credentials },
      }),
    );
    router.push(`/orgs/${orgId}/products/${productId}/integrations/${created.id}`);
  };

  /** Creates the connection, then sends the browser to Google's consent screen (WB-08 UC-08-01). */
  const connectGoogle = async () => {
    const created = unwrap(
      await api.POST('/api/v1/organizations/{orgId}/connections', {
        params: { path: { orgId } },
        body: { provider: 'google', displayName: 'Google', executionLocation: 'cloud', config: {} },
      }),
    );
    const { url } = unwrap(
      await api.POST('/api/v1/connections/{id}/oauth/google/start', {
        params: { path: { id: created.id } },
        body: { productId, missingOnly: false },
      }),
    );
    window.location.assign(url);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect the services this product runs on with read-only, scoped tokens. Discovered zones,
          repositories, and targets become assets; deployments and changes reach incidents, the AI assistant,
          and daily reports.
        </p>
      </div>
      <QueryState query={catalog} label="Loading integrations">
        <div className="grid gap-3 sm:grid-cols-2">
          {available.map((p) => {
            const spec = INTEGRATIONS[p];
            const entry = catalog.data!.connectors.find((c) => c.type === p)!;
            const count = (connections.data ?? []).filter((c) => c.provider === p).length;
            return (
              <Card key={p} className="flex flex-col justify-between gap-3 p-4">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {spec.title}
                    {count ? <Badge>{count} connected</Badge> : null}
                  </CardTitle>
                  <CardDescription>{spec.summary}</CardDescription>
                </div>
                {canConfigure ? (
                  <div>
                    {spec.oauth ? (
                      <GoogleConnectDialog onConnect={connectGoogle} />
                    ) : (
                      <ConnectDialog
                        spec={spec}
                        credentialFields={entry.credentialFields ?? []}
                        onSubmit={connect}
                      />
                    )}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      </QueryState>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Connected</h2>
        <QueryState query={connections} label="Loading connections">
          {(connections.data ?? []).length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
              Nothing connected yet.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {connections.data!.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                >
                  <Link
                    href={`/orgs/${orgId}/products/${productId}/integrations/${c.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {c.displayName}
                  </Link>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {c.scopes.length === 0 ? <Badge>not scoped yet</Badge> : null}
                    <Badge>{c.status.replace(/_/g, ' ')}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </section>
    </div>
  );
}
