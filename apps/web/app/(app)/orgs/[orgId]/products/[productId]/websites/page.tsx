'use client';

import { PageHeading } from '@/components/shell/page-heading';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { MetricChart, type Point } from '@/components/telemetry/metric-chart';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AddMonitorDialog, type NewMonitor } from '@/components/websites/add-monitor-dialog';
import { MonitorList, type MonitorRow } from '@/components/websites/monitor-list';
import { api, errorMessage } from '@/lib/api';
import type { Unit } from '@/lib/format';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

const RANGES = ['1h', '6h', '24h', '7d'] as const;
type Range = (typeof RANGES)[number];

export default function WebsitesPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const canManage = roleCan(role, 'pack.manage');
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [range, setRange] = useState<Range>('1h');
  const monitors = useApiQuery(
    ['website-monitors', productId],
    async () =>
      unwrap(
        await api.GET('/api/v1/products/{id}/website-monitors', { params: { path: { id: productId } } }),
      ).monitors.map(
        (m): MonitorRow => ({
          id: m.id,
          url: m.url,
          host: m.host,
          intervalSeconds: m.intervalSeconds,
          status: m.status,
          pausedReason: m.pausedReason ?? null,
          verification: m.verification,
          last: m.last?.checkedAt
            ? {
                checkedAt: m.last.checkedAt,
                up: m.last.up ?? null,
                statusCode: m.last.statusCode ?? null,
                error: m.last.error ?? null,
                totalMs: m.last.totalMs ?? null,
                consecutiveFailures: m.last.consecutiveFailures ?? 0,
              }
            : null,
          tls: m.tls?.expiresAt ? { expiresAt: m.tls.expiresAt, issuer: m.tls.issuer ?? null } : null,
        }),
      ),
    { refetchInterval: 15_000 },
  );
  const rows = monitors.data ?? [];
  // Charts follow the picked monitor, else the first one that is probed.
  const selected = rows.find((m) => m.id === picked) ?? rows.find((m) => m.status === 'active') ?? null;
  const metrics = useApiQuery(
    ['website-metrics', selected?.id, range],
    async () =>
      unwrap(
        await api.GET('/api/v1/website-monitors/{id}/metrics', {
          params: { path: { id: selected!.id }, query: { range } },
        }),
      ),
    { enabled: selected?.status === 'active', refetchInterval: 60_000 },
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['website-monitors', productId] });

  const add = async (input: NewMonitor) => {
    const created = unwrap(
      await api.POST('/api/v1/products/{id}/website-monitors', {
        params: { path: { id: productId } },
        body: input,
      }),
    );
    setPicked(created.id);
    await refresh();
  };

  return (
    <div className="portal-route portal-route-websites space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading
          eyebrow="Product operations"
          title="Websites & APIs"
          description="Availability and response times for your public endpoints."
        />
        {canManage ? <AddMonitorDialog onSubmit={add} /> : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <QueryState query={monitors} label="Loading websites">
        <MonitorList
          monitors={rows}
          canManage={canManage}
          now={new Date()}
          selected={selected?.id ?? null}
          onSelect={setPicked}
          onVerify={async (id) => {
            const r = unwrap(
              await api.POST('/api/v1/website-monitors/{id}/verify', { params: { path: { id } } }),
            );
            await refresh();
            return r;
          }}
          onDelete={async (id) => {
            setError(null);
            try {
              unwrap(await api.DELETE('/api/v1/website-monitors/{id}', { params: { path: { id } } }));
              await refresh();
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        />
      </QueryState>
      {selected?.status === 'active' ? (
        <section aria-label="Charts" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="truncate text-base font-semibold">{selected.url}</h2>
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
          <QueryState query={metrics} label="Loading charts">
            <div className="grid gap-4 lg:grid-cols-2">
              {(metrics.data?.charts ?? []).map((c) => (
                <MetricChart
                  key={c.key}
                  title={c.title}
                  unit={c.unit as Unit}
                  multiDay={range === '24h' || range === '7d'}
                  series={c.series.map((s, i) => ({
                    key: `${c.key}-${i}`,
                    label: s.label ?? c.title,
                    points: s.points as Point[],
                  }))}
                />
              ))}
            </div>
          </QueryState>
        </section>
      ) : null}
    </div>
  );
}
