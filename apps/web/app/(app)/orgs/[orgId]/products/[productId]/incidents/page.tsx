'use client';

import { PageHeading } from '@/components/shell/page-heading';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import { IncidentList, type IncidentFilter, type IncidentRow } from '@/components/alerting/incident-list';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { useApiQuery } from '@/lib/use-api-query';

export default function IncidentsPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const [filter, setFilter] = useState<IncidentFilter>('active');
  const incidents = useApiQuery(
    ['incidents', productId, filter],
    async () =>
      unwrap(
        await api.GET('/api/v1/products/{id}/incidents', {
          params: { path: { id: productId }, query: { status: filter } },
        }),
      ),
    { refetchInterval: 30_000 },
  );
  const base = `/orgs/${orgId}/products/${productId}`;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageHeading
          title={<>Incidents</>}
          description="What needs attention, with evidence and ownership attached."
          eyebrow="Product operations"
        />
        <Link className="text-sm text-primary hover:underline" href={`${base}/alert-rules`}>
          Alert rules
        </Link>
      </div>
      <QueryState query={incidents} label="Loading incidents">
        <IncidentList
          incidents={(incidents.data?.incidents ?? []) as IncidentRow[]}
          filter={filter}
          onFilter={setFilter}
          hrefFor={(id) => `${base}/incidents/${id}`}
        />
      </QueryState>
    </section>
  );
}
