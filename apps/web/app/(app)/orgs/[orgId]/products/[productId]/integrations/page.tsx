'use client';

import { PageHeading } from '@/components/shell/page-heading';

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

  /** Creates the connection with an uploaded service account key: no Google sign-in at all. */
  const connectGoogleKey = async (key: string) => {
    const created = unwrap(
      await api.POST('/api/v1/organizations/{orgId}/connections', {
        params: { path: { orgId } },
        body: { provider: 'google', displayName: 'Google', executionLocation: 'cloud', config: {} },
      }),
    );
    const path = { params: { path: { id: created.id } } };
    try {
      unwrap(await api.POST('/api/v1/connections/{id}/google/service-account', { ...path, body: { key } }));
    } catch (e) {
      // A refused key leaves no half-made connection behind.
      await api.DELETE('/api/v1/connections/{id}', path);
      throw e;
    }
    router.push(`/orgs/${orgId}/products/${productId}/integrations/${created.id}`);
  };

  return (
    <div className="portal-route portal-route-integrations space-y-6">
      <PageHeading
        eyebrow="Product operations"
        title="Integrations"
        description="Connect verified sources. Keep permissions and data gaps visible."
      />
      <QueryState query={catalog} label="Loading integrations">
        <div className="grid gap-3 sm:grid-cols-2">
          {available.map((p) => {
            const spec = INTEGRATIONS[p];
            const entry = catalog.data!.connectors.find((c) => c.type === p)!;
            const matched = (connections.data ?? []).filter((c) => c.provider === p);
            const count = matched.length;
            return (
              <Card key={p} className="flex flex-col justify-between gap-3 p-4">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2 text-base">{spec.title}</CardTitle>
                  <div className="portal-provider-status">
                    <Badge className={count ? 'text-success' : undefined}>
                      {count ? 'Connected' : 'Not connected'}
                    </Badge>
                  </div>
                  <CardDescription>{spec.summary}</CardDescription>
                </div>
                <div className="portal-provider-actions">
                  {matched[0] && (
                    <Link
                      className="portal-table-action"
                      href={`/orgs/${orgId}/products/${productId}/integrations/${matched[0].id}`}
                    >
                      Manage connection ↗
                    </Link>
                  )}
                  {canConfigure ? (
                    <div>
                      {spec.oauth ? (
                        <GoogleConnectDialog onConnect={connectGoogle} onUploadKey={connectGoogleKey} />
                      ) : (
                        <ConnectDialog
                          spec={spec}
                          credentialFields={entry.credentialFields ?? []}
                          onSubmit={connect}
                        />
                      )}
                    </div>
                  ) : null}
                </div>
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
