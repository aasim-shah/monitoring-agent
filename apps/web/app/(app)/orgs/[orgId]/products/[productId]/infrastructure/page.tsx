'use client';

import { PageHeading, PageMetrics } from '@/components/shell/page-heading';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { unwrap } from '@pcp/api-client';
import { AgentStatusBadge } from '@/components/agents/agent-status-badge';
import { Empty } from '@/components/states/empty';
import { UsageBar } from '@/components/telemetry/usage-bar';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { relativeTime } from '@/lib/relative-time';
import { useApiQuery } from '@/lib/use-api-query';

export default function InfrastructurePage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const infra = useApiQuery(
    ['infrastructure', productId],
    async () =>
      unwrap(
        await api.GET('/api/v1/products/{productId}/infrastructure', { params: { path: { productId } } }),
      ),
    { refetchInterval: 30_000 },
  );
  const hosts = infra.data?.hosts ?? [];
  const base = `/orgs/${orgId}/products/${productId}`;
  return (
    <div className="portal-route portal-route-infrastructure space-y-4">
      <PageHeading
        eyebrow="Product operations"
        title="Infrastructure"
        description="Host signals alongside the services they support."
      />
      {infra.data && (
        <PageMetrics
          items={[
            { label: 'Hosts', value: hosts.length, detail: 'In this product' },
            {
              label: 'Reporting',
              value: hosts.filter((h) => !h.stale && h.lastSampleAt).length,
              detail: 'With current telemetry',
            },
            {
              label: 'Stale sources',
              value: hosts.filter((h) => h.stale).length,
              detail: 'Last values may be outdated',
            },
          ]}
        />
      )}
      <QueryState query={infra} label="Loading infrastructure">
        {hosts.length === 0 ? (
          <Empty
            title="No servers yet"
            description="Install the agent on a server to see its CPU, memory, disk, and network here."
            action={
              <Link href={`${base}/agents`} className="text-sm font-medium underline">
                Add server
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {hosts.map((h) => (
              <li key={h.agentId} className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
                <div className="min-w-48 flex-1">
                  <Link
                    href={`${base}/infrastructure/${h.agentId}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {h.hostname}
                  </Link>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{h.environmentName}</span>
                    <AgentStatusBadge status={h.status} stale={h.stale} />
                    <span>metrics {relativeTime(h.lastSampleAt)}</span>
                  </div>
                </div>
                <UsageBar label="CPU" percent={h.cpuPercent} />
                <UsageBar label="Memory" percent={h.memoryPercent} />
                <UsageBar label="Disk" percent={h.diskPercent} />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
