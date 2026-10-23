'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { AddDatabaseDialog, type NewDatabase } from '@/components/databases/add-database-dialog';
import { DatabaseList, type DatabaseRow } from '@/components/databases/database-list';
import { WorkerPanel, type WorkerSummary } from '@/components/databases/worker-panel';
import { Alert } from '@/components/ui/alert';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

const DB_PROVIDERS = ['postgres', 'mysql', 'mongodb'];

export default function DatabasesPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const [error, setError] = useState<string | null>(null);
  const product = useApiQuery(['product', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{productId}', { params: { path: { productId } } })),
  );
  const agents = useApiQuery(
    ['agents', productId],
    async () =>
      unwrap(await api.GET('/api/v1/products/{productId}/agents', { params: { path: { productId } } })),
    { refetchInterval: 15_000 },
  );
  const connections = useApiQuery(
    ['db-connections', orgId, productId],
    async () => {
      const all = unwrap(
        await api.GET('/api/v1/organizations/{orgId}/connections', { params: { path: { orgId } } }),
      ).connections.filter(
        (c) => DB_PROVIDERS.includes(c.provider) && c.scopes.some((s) => s.productId === productId),
      );
      // Latest health for each database (connections, size, replication, slow queries).
      return Promise.all(
        all.map(async (c): Promise<DatabaseRow> => {
          const h = unwrap(
            await api.GET('/api/v1/connections/{id}/health', { params: { path: { id: c.id } } }),
          );
          return {
            id: c.id,
            displayName: c.displayName,
            provider: c.provider,
            status: c.status,
            statusReason: c.statusReason ?? null,
            health: (h.latest as { ok?: boolean; data?: Record<string, unknown> } | null)?.ok
              ? (h.latest as { data: Record<string, unknown> }).data
              : null,
          };
        }),
      );
    },
    {
      refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'pending_validation') ? 3000 : 30_000),
    },
  );
  const catalog = useApiQuery(['connector-catalog'], async () =>
    unwrap(await api.GET('/api/v1/connectors/catalog')),
  );
  const workers: WorkerSummary[] = (agents.data?.agents ?? [])
    .filter((a) => a.agentType === 'private_worker')
    .map((a) => ({ id: a.id, hostname: a.hostname, status: a.status, stale: a.stale }));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['db-connections', orgId, productId] });

  const addDatabase = async (input: NewDatabase) => {
    const { mode: _mode, ...body } = input;
    const created = unwrap(
      await api.POST('/api/v1/organizations/{orgId}/connections', {
        params: { path: { orgId } },
        body: {
          provider: body.provider,
          displayName: body.displayName,
          executionLocation: body.executionLocation,
          config: body.config,
        },
      }),
    );
    if (input.mode === 'managed')
      // The connection string goes to the credentials endpoint only (encrypted at rest); validation starts there.
      unwrap(
        await api.POST('/api/v1/connections/{id}/authorize', {
          params: { path: { id: created.id } },
          body: { credentials: { connectionString: input.connectionString } },
        }),
      );
    // Scope it to this product so product-scoped members see it here.
    unwrap(
      await api.POST('/api/v1/connections/{id}/resource-scopes', {
        params: { path: { id: created.id } },
        body: {
          scopes: [
            {
              externalId: String(input.config.database ?? input.config.host),
              resourceType: 'database',
              name: input.displayName,
              productId,
            },
          ],
        },
      }),
    );
    await refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Databases</h1>
          <p className="text-sm text-muted-foreground">
            PostgreSQL, MySQL, and MongoDB health with a read-only user: managed databases (Atlas, Supabase,
            RDS) directly over TLS, private ones through a worker. No free-form queries.
          </p>
        </div>
        {roleCan(role, 'connection.configure') ? (
          <AddDatabaseDialog
            workers={workers.filter((w) => w.status !== 'revoked')}
            egressIp={catalog.data?.egressIp ?? null}
            onSubmit={addDatabase}
          />
        ) : null}
      </div>
      <WorkerPanel
        workers={workers}
        environments={(product.data?.environments ?? []).map((e) => ({ id: e.id, name: e.name }))}
        canEnroll={roleCan(role, 'agent.enroll')}
        onCreate={async (environmentId) =>
          unwrap(
            await api.POST('/api/v1/environments/{environmentId}/agent-enrollments', {
              params: { path: { environmentId } },
              body: { agentType: 'private_worker', maxUses: 1, expiresInMinutes: 60 },
            }),
          )
        }
      />
      {error ? <Alert>{error}</Alert> : null}
      <QueryState query={connections} label="Loading databases">
        <DatabaseList
          rows={connections.data ?? []}
          canConfigure={roleCan(role, 'connection.configure')}
          onOverride={async (id) => {
            setError(null);
            try {
              unwrap(await api.POST('/api/v1/connections/{id}/write-override', { params: { path: { id } } }));
              await refresh();
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        />
      </QueryState>
    </div>
  );
}
