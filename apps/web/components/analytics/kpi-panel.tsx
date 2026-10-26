'use client';

import { MetricChart } from '@/components/telemetry/metric-chart';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/relative-time';

export interface KpiView {
  key: string;
  label: string;
  unit: string;
  definition: string;
  caveats: string[];
  lowerIsBetter?: boolean;
  total: number | null;
  points: Array<{ day: string; value: number | null; completeness: string | null }>;
}

export interface KpiResource {
  connectionId: string;
  resourceType: string;
  externalId: string;
  name: string;
  kpis: KpiView[];
  breakdown?: {
    sessionsByChannel?: Array<{ channel: string; value: number }>;
    costByService?: Array<{ service: string; value: number }>;
  };
}

export interface FreshnessView {
  status: string;
  reason: string | null;
  lastSuccessfulSync: string | null;
  lastAttempt: string | null;
  expectedIntervalSeconds: number;
}

/** A KPI value for display; a missing value is "No data", never 0 (BR-09-05). */
export function formatKpi(value: number | null, unit: string): string {
  if (value === null) return 'No data';
  if (unit === 'USD')
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  if (unit === 'bytes') return `${Number((value / 1073741824).toFixed(3))} GiB`;
  if (unit === 'ms') return `${Number(value.toFixed(2))} ms`;
  if (unit === 'ratio') return `${Number((value * 100).toFixed(value < 0.1 ? 2 : 1))}%`;
  if (unit === 'position') return value.toFixed(1);
  return Math.abs(value) >= 100
    ? Math.round(value).toLocaleString('en-US')
    : String(Number(value.toFixed(2)));
}

const epoch = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

/** Tiles, one daily chart, and the GA4 channel table for one property, site, or app. */
export function KpiResourcePanel({ resource, chartKey }: { resource: KpiResource; chartKey?: string }) {
  const chart = resource.kpis.find((k) => k.key === chartKey) ?? resource.kpis[0];
  const partialToday = resource.kpis.some((k) => k.points.at(-1)?.completeness === 'partial');
  const channels = resource.breakdown?.sessionsByChannel ?? [];
  return (
    <section aria-label={resource.name} className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{resource.name}</h2>
      <ul
        aria-label={`${resource.name} KPIs`}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
      >
        {resource.kpis.map((k) => (
          <li
            key={k.key}
            aria-label={k.label}
            title={[k.definition, ...k.caveats].join(' ')}
            className="rounded-md border border-border p-2"
          >
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p
              className={cn(
                'text-lg font-semibold',
                k.total === null && 'text-sm font-normal text-muted-foreground',
              )}
            >
              {formatKpi(k.total, k.unit)}
            </p>
          </li>
        ))}
      </ul>
      {partialToday ? (
        <p className="text-xs text-muted-foreground">
          Today is partial: the provider is still processing it.
        </p>
      ) : null}
      {chart ? (
        <MetricChart
          title={`${chart.label} per day`}
          unit={
            chart.unit === 'ratio' || chart.unit === 'percent'
              ? 'percent'
              : chart.unit === 'USD'
                ? 'USD'
                : chart.unit === 'bytes'
                  ? 'bytes'
                  : chart.unit === 'ms'
                    ? 'ms'
                    : 'count'
          }
          multiDay
          series={[
            {
              key: chart.key,
              label: chart.label,
              points: chart.points.map((p) => [
                epoch(p.day),
                p.value === null ? null : chart.unit === 'ratio' ? p.value * 100 : p.value,
              ]),
            },
          ]}
        />
      ) : null}
      {resource.breakdown?.costByService?.length ? (
        <table aria-label="AWS cost by service" className="w-full text-left text-xs">
          <thead>
            <tr>
              <th>Service</th>
              <th>Unblended cost (USD, selected UTC range)</th>
            </tr>
          </thead>
          <tbody>
            {resource.breakdown.costByService.map((c) => (
              <tr key={c.service}>
                <td>{c.service}</td>
                <td>{formatKpi(c.value, 'USD')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {channels.length ? (
        <table aria-label="Sessions by channel" className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Channel</th>
              <th className="py-1 text-right font-medium">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {channels.slice(0, 8).map((c) => (
              <tr key={c.channel} className="border-t border-border">
                <td className="py-1">{c.channel}</td>
                <td className="py-1 text-right">{formatKpi(c.value, 'count')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

const STATUS: Record<string, string> = { current: 'up to date', stale: 'stale', unavailable: 'no data yet' };

/** "as of" for one source (spec §11.3): its state, the reason, and when it last synced. */
export function FreshnessLine({
  name,
  freshness,
  now = new Date(),
}: {
  name: string;
  freshness: FreshnessView;
  now?: Date;
}) {
  const reason = freshness.reason ? ` — ${freshness.reason}` : '';
  const last = freshness.lastSuccessfulSync
    ? ` Last synced ${relativeTime(freshness.lastSuccessfulSync, now)}.`
    : ' Not synced yet.';
  return (
    <p
      role="status"
      className={cn('text-xs', freshness.status === 'current' ? 'text-muted-foreground' : 'text-amber-600')}
    >
      {`${name}: ${STATUS[freshness.status] ?? freshness.status}${reason}.${last}`}
    </p>
  );
}
