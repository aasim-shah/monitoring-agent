'use client';

import { PageHeading } from '@/components/shell/page-heading';

import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { AddServerDialog } from '@/components/agents/add-server-dialog';
import { AssistedInstallDialog, type AssistedInstallApi } from '@/components/agents/assisted-install';
import { FleetTable } from '@/components/agents/fleet-table';
import { Alert } from '@/components/ui/alert';
import { Empty } from '@/components/states/empty';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

/** Assisted SSH install calls (M17.3); the browser never sees the token, key, or a stored password. */
const assistedApi: AssistedInstallApi = {
  create: async (environmentId, body) =>
    unwrap(
      await api.POST('/api/v1/environments/{environmentId}/install-sessions', {
        params: { path: { environmentId } },
        body,
      }),
    ),
  connect: async (id, password) => {
    unwrap(
      await api.POST('/api/v1/install-sessions/{id}/connect', {
        params: { path: { id } },
        body: password ? { password } : {},
      }),
    );
  },
  confirm: async (id, hostId, fingerprint) => {
    unwrap(
      await api.POST('/api/v1/install-sessions/{id}/hosts/{hostId}/confirm-fingerprint', {
        params: { path: { id, hostId } },
        body: { fingerprint },
      }),
    );
  },
  get: async (id) => unwrap(await api.GET('/api/v1/install-sessions/{id}', { params: { path: { id } } })),
  abort: async (id) => {
    unwrap(await api.DELETE('/api/v1/install-sessions/{id}', { params: { path: { id } } }));
  },
};

export default function AgentsPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const org = useOrganization(orgId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const createdAt = useRef<number | null>(null);
  const product = useApiQuery(['product', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{productId}', { params: { path: { productId } } })),
  );
  const agents = useApiQuery(
    ['agents', productId],
    async () =>
      unwrap(await api.GET('/api/v1/products/{productId}/agents', { params: { path: { productId } } })),
    { refetchInterval: dialogOpen ? 3000 : 15000 },
  );
  const canEnroll = org.data ? roleCan(org.data.role as Role, 'agent.enroll') : false;
  const list = agents.data?.agents ?? [];
  const since = createdAt.current;
  const connected = since
    ? list.filter((a) => new Date(a.createdAt).getTime() >= since).map((a) => a.hostname)
    : [];

  // One dialog instance for the page's lifetime: it must stay open while the first server
  // joins, when the empty state below is replaced by the fleet table.
  const dialog = canEnroll ? (
    <AddServerDialog
      environments={(product.data?.environments ?? []).map((e) => ({ id: e.id, name: e.name }))}
      connected={connected}
      onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) createdAt.current = null;
      }}
      onCreate={async ({ environmentId, ...body }) => {
        const created = unwrap(
          await api.POST('/api/v1/environments/{environmentId}/agent-enrollments', {
            params: { path: { environmentId } },
            body: { agentType: 'host', ...body },
          }),
        );
        createdAt.current = Date.now() - 5000;
        return created;
      }}
    />
  ) : null;

  return (
    <div className="portal-route portal-route-agents space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading
          eyebrow="Product operations"
          title="Agents"
          description="Enroll servers and review their trusted connection state."
        />
        <div className="flex flex-wrap gap-2">
          {canEnroll ? (
            <AssistedInstallDialog
              environments={(product.data?.environments ?? []).map((e) => ({ id: e.id, name: e.name }))}
              api={assistedApi}
            />
          ) : null}
          {dialog}
        </div>
      </div>
      <QueryState query={agents} label="Loading agents">
        {list.length === 0 ? (
          <Empty
            title="No servers yet"
            description="Add a server: copy one command, run it on your VPS, and it appears here within a minute."
          />
        ) : (
          <FleetTable agents={list} basePath={`/orgs/${orgId}/products/${productId}/agents`} />
        )}
      </QueryState>
      <Alert tone="info">
        <div>
          <strong className="block mb-1">Enrollment is scoped</strong>Installation tokens are short-lived and
          scoped to the selected environment. Keep install commands private.
        </div>
      </Alert>
    </div>
  );
}
