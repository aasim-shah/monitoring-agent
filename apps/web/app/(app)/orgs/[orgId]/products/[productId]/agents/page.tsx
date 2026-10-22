'use client';

import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { AddServerDialog } from '@/components/agents/add-server-dialog';
import { FleetTable } from '@/components/agents/fleet-table';
import { Empty } from '@/components/states/empty';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Servers running the monitoring agent. Status turns Degraded after 90 s without a heartbeat.
          </p>
        </div>
        {dialog}
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
    </div>
  );
}
