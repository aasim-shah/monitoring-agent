'use client';

import Link from 'next/link';
import { PageHeading } from '@/components/shell/page-heading';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import {
  FreshnessLine,
  KpiResourcePanel,
  type FreshnessView,
  type KpiResource,
} from '@/components/analytics/kpi-panel';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { useApiQuery } from '@/lib/use-api-query';

export type KpiRange = '7d' | '28d' | '90d';

export interface ProductKpis {
  range: string;
  days: string[];
  gaps: string[];
  connections: Array<{
    id: string;
    displayName: string;
    accountEmail: string | null;
    freshness: FreshnessView;
  }>;
  resources: KpiResource[];
}

/** Loads a product's KPIs for a range; shared by the Analytics and Mobile pages. */
export function useProductKpis(productId: string, range: KpiRange) {
  return useApiQuery(
    ['kpis', productId, range],
    async () =>
      unwrap(
        await api.GET('/api/v1/products/{productId}/kpis', {
          params: { path: { productId }, query: { range } },
        }),
      ) as unknown as ProductKpis,
  );
}

export function RangePicker({ value, onChange }: { value: KpiRange; onChange: (r: KpiRange) => void }) {
  return (
    <div role="group" aria-label="Range" className="flex gap-1">
      {(['7d', '28d', '90d'] as const).map((r) => (
        <Button
          key={r}
          size="sm"
          variant={r === value ? 'default' : 'outline'}
          aria-pressed={r === value}
          onClick={() => onChange(r)}
        >
          {r}
        </Button>
      ))}
    </div>
  );
}

/** One page of KPI sources: freshness per connection, panels for the given resource types, and gaps. */
export function KpiSources({
  orgId,
  productId,
  title,
  intro,
  resourceTypes,
  chartKeys,
  children,
  emptyHint,
}: {
  orgId: string;
  productId: string;
  title: string;
  intro: string;
  resourceTypes: string[];
  chartKeys: Record<string, string>;
  children?: (data: ProductKpis) => React.ReactNode;
  emptyHint: string;
}) {
  const [range, setRange] = useState<KpiRange>('28d');
  const kpis = useProductKpis(productId, range);
  const integrations = `/orgs/${orgId}/products/${productId}/integrations`;
  return (
    <div className="space-y-4">
      <PageHeading
        title={title}
        description={intro}
        action={<RangePicker value={range} onChange={setRange} />}
      />
      <QueryState query={kpis} label={`Loading ${title}`}>
        {kpis.data ? (
          <>
            {kpis.data.connections.map((c) => (
              <FreshnessLine
                key={c.id}
                name={`${c.displayName}${c.accountEmail ? ` (${c.accountEmail})` : ''}`}
                freshness={c.freshness}
              />
            ))}
            {kpis.data.gaps.includes('Google: not connected') ? (
              <Alert tone="info">
                Google is not connected.{' '}
                <Link className="underline" href={integrations}>
                  Connect Google
                </Link>{' '}
                to see {emptyHint}.
              </Alert>
            ) : null}
            {kpis.data.resources
              .filter((r) => resourceTypes.includes(r.resourceType) && r.kpis.length)
              .map((r) => (
                <KpiResourcePanel
                  key={`${r.connectionId}:${r.externalId}`}
                  resource={r}
                  chartKey={chartKeys[r.resourceType]}
                />
              ))}
            {kpis.data.connections.length &&
            !kpis.data.resources.some((r) => resourceTypes.includes(r.resourceType)) ? (
              <Alert tone="info">
                Nothing is scoped to this product yet. Open the Google connection under{' '}
                <Link className="underline" href={integrations}>
                  Integrations
                </Link>{' '}
                and choose {emptyHint}.
              </Alert>
            ) : null}
            {children?.(kpis.data)}
            {kpis.data.gaps.filter((g) => g !== 'Google: not connected').length ? (
              <section aria-label="Not available" className="rounded-lg border border-border bg-card p-4">
                <h2 className="text-sm font-semibold">Not available</h2>
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {kpis.data.gaps
                    .filter((g) => g !== 'Google: not connected')
                    .map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </QueryState>
    </div>
  );
}
