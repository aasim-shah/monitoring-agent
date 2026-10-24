'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import { MetricChart, type Point } from '@/components/telemetry/metric-chart';
import { Alert } from '@/components/ui/alert';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { sealCredentials } from '@/lib/seal';
import { useApiQuery } from '@/lib/use-api-query';
import type { EnablePackBody } from './enable-pack-dialog';
import { GuidedSetup, type Guide } from './guided-setup';
import { InspectionPanel, type InspectionApi } from './inspection-panel';
import { RetainLogsToggle } from './retain-logs-toggle';

/** Packs with log files the agent can ship (the M11 log sources). */
const PACKS_WITH_LOGS = new Set(['redis', 'postgresql', 'mysql', 'mongodb', 'kafka', 'nginx']);
import { LiveBoostControl } from './live-boost';
import { ServicesPanel, type Assignment, type CatalogPack } from './services-panel';

type Range = '15m' | '1h' | '6h' | '24h' | '7d';

/** Charts for one enabled pack, from the fixed per-pack templates. */
function ServiceCharts({
  agentId,
  packId,
  name,
  range: chosen,
  boostedUntil,
  onBoost,
  guide,
  retainLogs,
}: {
  agentId: string;
  packId: string;
  name: string;
  range: Range;
  /** Retained logs opt-in for packs with log files (M18.1). */
  retainLogs?: { enabled: boolean; onChange: (enabled: boolean) => Promise<void> };
  /** Set while a live boost runs: the last 15 minutes, refreshed every 5 s. */
  boostedUntil: string | null;
  onBoost?: () => Promise<void>;
  guide?: Guide;
}) {
  const live = boostedUntil !== null && Date.parse(boostedUntil) > Date.now();
  const range: Range = live ? '15m' : chosen;
  const metrics = useApiQuery(
    ['service-metrics', agentId, packId, range],
    async () =>
      unwrap(
        await api.GET('/api/v1/agents/{id}/services/{packId}/metrics', {
          params: { path: { id: agentId, packId }, query: { range } },
        }),
      ),
    { refetchInterval: live ? 5_000 : 30_000 },
  );
  const multiDay = range === '24h' || range === '7d';
  return (
    <section className="space-y-2" aria-label={`${name} metrics`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{name}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {guide ? (
            <GuidedSetup
              name={name}
              guide={guide}
              verify={async () =>
                unwrap(
                  await api.GET('/api/v1/agents/{id}/packs/{packId}/verification', {
                    params: { path: { id: agentId, packId } },
                  }),
                ) as { status: 'active' | 'not_found'; series: number }
              }
            />
          ) : null}
          {retainLogs ? (
            <RetainLogsToggle name={name} enabled={retainLogs.enabled} onChange={retainLogs.onChange} />
          ) : null}
          {onBoost ? <LiveBoostControl name={name} until={boostedUntil} onStart={onBoost} /> : null}
        </div>
      </div>
      <QueryState query={metrics} label={`Loading ${name} metrics`}>
        <div className="grid gap-4 lg:grid-cols-2">
          {metrics.data?.charts.map((c) => (
            <MetricChart
              key={c.key}
              title={c.title}
              unit={c.unit}
              multiDay={multiDay}
              series={c.series.map((s, i) => ({ key: `s${i}`, label: s.label, points: s.points as Point[] }))}
            />
          ))}
        </div>
      </QueryState>
    </section>
  );
}

/** "Services on this server": discovery, pack status, enable/disable, and service charts. */
export function ServicesSection({
  agentId,
  x25519PublicKey,
  canManage,
  canInspect = false,
  canConfigureInspection = false,
  range,
}: {
  agentId: string;
  x25519PublicKey: string | null;
  canManage: boolean;
  /** Data inspection (M18.2): run it, and turn it on with allowlists (owner, admin). */
  canInspect?: boolean;
  canConfigureInspection?: boolean;
  range: Range;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const catalog = useApiQuery(['monitoring-packs'], async () =>
    unwrap(await api.GET('/api/v1/monitoring-packs')),
  );
  const inventory = useApiQuery(
    ['agent-inventory', agentId],
    async () => unwrap(await api.GET('/api/v1/agents/{id}/inventory', { params: { path: { id: agentId } } })),
    { refetchInterval: 60_000 },
  );
  const packs = useApiQuery(
    ['agent-packs', agentId],
    async () => unwrap(await api.GET('/api/v1/agents/{id}/packs', { params: { path: { id: agentId } } })),
    // Poll quickly while a change is being applied (one heartbeat, 30 s).
    {
      refetchInterval: (q) =>
        q.state.data?.packs.some((p) => p.status === 'pending' || p.status === 'removing') ? 5_000 : 30_000,
    },
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['agent-packs', agentId] });
  const boosts = useApiQuery(
    ['live-boosts', agentId],
    async () =>
      unwrap(await api.GET('/api/v1/agents/{id}/live-boost', { params: { path: { id: agentId } } })).boosts,
    { refetchInterval: 30_000 },
  );
  const onBoost = async (packId: string) => {
    unwrap(
      await api.POST('/api/v1/agents/{id}/live-boost', {
        params: { path: { id: agentId } },
        body: { packId },
      }),
    );
    await queryClient.invalidateQueries({ queryKey: ['live-boosts', agentId] });
  };

  const seal = async (fields: Record<string, string>) => {
    if (!x25519PublicKey)
      throw new Error('This agent has no encryption key; re-enroll it to add credentials.');
    return sealCredentials(x25519PublicKey, fields);
  };
  const onEnable = async (body: EnablePackBody) => {
    unwrap(await api.POST('/api/v1/agents/{id}/packs', { params: { path: { id: agentId } }, body }));
    await refresh();
  };
  const onDisable = async (packId: string) => {
    setError(null);
    try {
      unwrap(
        await api.DELETE('/api/v1/agents/{id}/packs/{packId}', { params: { path: { id: agentId, packId } } }),
      );
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const inspectionApi = (packId: string): InspectionApi => ({
    configure: async (body) => {
      const saved = unwrap(
        await api.PATCH('/api/v1/agents/{id}/packs/{packId}/inspection', {
          params: { path: { id: agentId, packId } },
          body,
        }),
      );
      await refresh();
      return saved;
    },
    request: async (body) =>
      unwrap(await api.POST('/api/v1/agents/{id}/inspections', { params: { path: { id: agentId } }, body })),
    get: async (id) => unwrap(await api.GET('/api/v1/inspections/{id}', { params: { path: { id } } })),
  });

  const cat = (catalog.data?.packs ?? []) as CatalogPack[];
  const assignments = (packs.data?.packs ?? []) as Assignment[];
  const charted = assignments.filter((a) => a.status === 'applied' || a.status === 'pending');
  return (
    <section className="space-y-4" aria-labelledby="services-heading">
      <h2 id="services-heading" className="text-lg font-semibold">
        Services on this server
      </h2>
      {error ? <Alert>{error}</Alert> : null}
      <QueryState query={inventory} label="Loading services">
        <ServicesPanel
          catalog={cat}
          services={inventory.data?.inventory?.services ?? []}
          warnings={inventory.data?.inventory?.warnings ?? []}
          assignments={assignments}
          canManage={canManage}
          seal={seal}
          onEnable={onEnable}
          onDisable={onDisable}
        />
      </QueryState>
      {charted.map((a) => (
        <div key={a.packId} className="space-y-2">
          <ServiceCharts
            agentId={agentId}
            packId={a.packId}
            name={cat.find((p) => p.id === a.packId)?.name ?? a.packId}
            range={range}
            boostedUntil={
              (boosts.data ?? []).find((b) => b.packId === a.packId)?.expiresAt?.toString() ?? null
            }
            onBoost={a.status === 'applied' ? () => onBoost(a.packId) : undefined}
            guide={cat.find((p) => p.id === a.packId)?.guide}
          />
          {a.status === 'applied' &&
          (a.packId === 'redis' || a.packId === 'kafka') &&
          (canInspect || canConfigureInspection) ? (
            <InspectionPanel
              name={cat.find((p) => p.id === a.packId)?.name ?? a.packId}
              packId={a.packId}
              settings={a.inspection ?? { enabled: false, redisKeys: [], peekTopics: [] }}
              canConfigure={canConfigureInspection}
              canRun={canInspect}
              api={inspectionApi(a.packId)}
            />
          ) : null}
        </div>
      ))}
    </section>
  );
}
