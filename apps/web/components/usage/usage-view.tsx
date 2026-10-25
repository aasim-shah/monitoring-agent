'use client';

import Link from 'next/link';
import { MetricChart } from '@/components/telemetry/metric-chart';
import { Alert } from '@/components/ui/alert';

export interface UsageData {
  range: string;
  buckets: Array<{ start: string; samples: number; activeSeries: number; refusedRequests: number }>;
  totals: { samples: number; activeSeries: number; refusedRequests: number };
  limits: { agentSeries: number; tenantSeries: number; agentSamplesPerSecond: number };
  overLimitSince: string | null;
}

const n = (v: number) => Math.round(v).toLocaleString('en-US');

/** Telemetry usage against the ingest limits (M10.6, spec §11.6). */
export function UsageView({ data }: { data: UsageData }) {
  const epoch = (iso: string) => Date.parse(iso) / 1000;
  return (
    <div className="portal-feature-section space-y-4">
      <ul aria-label="Usage totals" className="grid gap-2 sm:grid-cols-3">
        <li aria-label="Active series" className="rounded-md border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">Active series (this hour)</p>
          <p className="text-lg font-semibold">
            {n(data.totals.activeSeries)} of {n(data.limits.tenantSeries)}
          </p>
        </li>
        <li aria-label="Samples" className="rounded-md border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">Samples ({data.range})</p>
          <p className="text-lg font-semibold">{n(data.totals.samples)}</p>
        </li>
        <li aria-label="Refused requests" className="rounded-md border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">Refused requests ({data.range})</p>
          <p
            className={
              data.totals.refusedRequests ? 'text-lg font-semibold text-destructive' : 'text-lg font-semibold'
            }
          >
            {n(data.totals.refusedRequests)}
          </p>
        </li>
      </ul>
      <MetricChart
        title="Active series"
        unit="count"
        multiDay={data.range === '7d'}
        series={[
          {
            key: 'series',
            label: 'Active series',
            points: data.buckets.map((b) => [epoch(b.start), b.activeSeries]),
          },
        ]}
      />
      <MetricChart
        title="Samples"
        unit="count"
        multiDay={data.range === '7d'}
        series={[
          { key: 'samples', label: 'Samples', points: data.buckets.map((b) => [epoch(b.start), b.samples]) },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        Limits: {n(data.limits.agentSeries)} series per agent, {n(data.limits.tenantSeries)} per organization,{' '}
        {n(data.limits.agentSamplesPerSecond)} samples/s per agent. Over a limit, new series or excess samples
        are refused and the agent retries; existing series keep flowing and nothing is dropped silently.
      </p>
    </div>
  );
}

/** Shown on every organization page while telemetry was refused in the last hour. */
export function LimitBanner({ since, usageHref }: { since: string; usageHref: string }) {
  const at = new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <Alert className="mb-4">
      Telemetry limit reached since {at}: new series or excess samples are being refused. Existing series keep
      flowing.{' '}
      <Link className="underline" href={usageHref}>
        See usage
      </Link>
    </Alert>
  );
}
