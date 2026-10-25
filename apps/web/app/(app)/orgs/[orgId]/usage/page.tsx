'use client';

import { PageHeading } from '@/components/shell/page-heading';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import { UsageView, type UsageData } from '@/components/usage/usage-view';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { useApiQuery } from '@/lib/use-api-query';

export default function UsagePage() {
  const { orgId } = useParams<{ orgId: string }>();
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const usage = useApiQuery(
    ['usage', orgId, range],
    async () =>
      unwrap(
        await api.GET('/api/v1/organizations/{orgId}/usage', {
          params: { path: { orgId }, query: { range } },
        }),
      ) as UsageData,
    { refetchInterval: 60_000 },
  );
  return (
    <section className="portal-route portal-route-usage space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading
          eyebrow="Workspace"
          title={<>Usage</>}
          description={<>Telemetry this organization sends, against its limits.</>}
        />
        <div role="group" aria-label="Range" className="flex gap-1">
          {(['24h', '7d'] as const).map((r) => (
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
      <QueryState query={usage} label="Loading usage">
        {usage.data ? <UsageView data={usage.data} /> : null}
      </QueryState>
    </section>
  );
}
