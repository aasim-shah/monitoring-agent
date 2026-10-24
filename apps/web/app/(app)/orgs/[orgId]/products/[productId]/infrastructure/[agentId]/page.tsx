'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { AgentStatusBadge } from '@/components/agents/agent-status-badge';
import { LogsSection } from '@/components/logs/logs-section';
import { ServicesSection } from '@/components/services/services-section';
import { MetricChart, type Point } from '@/components/telemetry/metric-chart';
import { StaleBanner } from '@/components/telemetry/stale-banner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

// 30d and 90d read the 5-minute rollups when they are on (M18.4).
const RANGES = ['15m', '1h', '6h', '24h', '7d', '30d', '90d'] as const;
type Range = (typeof RANGES)[number];

/** The API's MetricPoint is a [time, value | null] pair; OpenAPI types it as a plain array. */
const pts = (p: Array<Array<number | null>>) => p as Point[];

export default function HostMetricsPage() {
  const { orgId, productId, agentId } = useParams<{ orgId: string; productId: string; agentId: string }>();
  const [range, setRange] = useState<Range>('1h');
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const agent = useApiQuery(['agent', agentId], async () =>
    unwrap(await api.GET('/api/v1/agents/{id}', { params: { path: { id: agentId } } })),
  );
  const metrics = useApiQuery(
    ['host-metrics', agentId, range],
    async () =>
      unwrap(
        await api.GET('/api/v1/agents/{id}/metrics', { params: { path: { id: agentId }, query: { range } } }),
      ),
    { refetchInterval: range === '15m' || range === '1h' ? 30_000 : 120_000 },
  );
  const m = metrics.data;
  const multiDay = range === '24h' || range === '7d' || range === '30d' || range === '90d';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            href={`/orgs/${orgId}/products/${productId}/infrastructure`}
            className="text-sm text-muted-foreground hover:underline"
          >
            ← Infrastructure
          </Link>
          <h1 className="flex items-center gap-3 text-xl font-semibold">
            {agent.data?.hostname ?? 'Server'}
            {agent.data ? <AgentStatusBadge status={agent.data.status} stale={agent.data.stale} /> : null}
          </h1>
          {agent.data ? (
            <p className="text-sm text-muted-foreground">
              {agent.data.environmentName} · {agent.data.os} · {agent.data.arch} ·{' '}
              <Link href={`/orgs/${orgId}/products/${productId}/agents/${agentId}`} className="underline">
                agent details
              </Link>
            </p>
          ) : null}
        </div>
        <div role="group" aria-label="Time range" className="flex gap-1">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === range ? 'default' : 'outline'}
              aria-pressed={r === range}
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      </div>
      <QueryState query={metrics} label="Loading metrics">
        {m ? (
          <div className="space-y-4">
            <StaleBanner lastSampleAt={m.lastSampleAt} />
            {m.completeness === 'partial' ? (
              <Alert tone="info">Partial range: {m.gaps.join('; ')}</Alert>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-2">
              <MetricChart
                title="CPU"
                unit="percent"
                multiDay={multiDay}
                series={[{ key: 'cpu', label: 'CPU', points: pts(m.series.cpu) }]}
              />
              <MetricChart
                title="Memory"
                unit="percent"
                multiDay={multiDay}
                series={[{ key: 'memory', label: 'Memory', points: pts(m.series.memory) }]}
              />
              <MetricChart
                title="Network"
                unit="bytesPerSecond"
                multiDay={multiDay}
                series={[
                  { key: 'in', label: 'In', points: pts(m.series.networkIn) },
                  { key: 'out', label: 'Out', points: pts(m.series.networkOut) },
                ]}
              />
              <MetricChart
                title={m.series.disk.length > 3 ? 'Disk (3 fullest mounts)' : 'Disk'}
                unit="percent"
                multiDay={multiDay}
                series={[...m.series.disk]
                  .sort((a, b) => (pts(b.points).at(-1)?.[1] ?? 0) - (pts(a.points).at(-1)?.[1] ?? 0))
                  .map((d) => ({
                    key: d.mountpoint || '/',
                    label: d.mountpoint || '/',
                    points: pts(d.points),
                  }))}
              />
            </div>
          </div>
        ) : null}
      </QueryState>
      {agent.data ? (
        <ServicesSection
          agentId={agentId}
          x25519PublicKey={agent.data.x25519PublicKey ?? null}
          canManage={roleCan(role, 'pack.manage')}
          canInspect={roleCan(role, 'data.inspect')}
          canConfigureInspection={roleCan(role, 'data.inspect.configure')}
          // Pack series are not rolled up; service charts stop at 7 days.
          range={range === '30d' || range === '90d' ? '7d' : range}
        />
      ) : null}
      {agent.data ? (
        <LogsSection agentId={agentId} productId={productId} canTail={roleCan(role, 'logs.tail')} />
      ) : null}
    </div>
  );
}
