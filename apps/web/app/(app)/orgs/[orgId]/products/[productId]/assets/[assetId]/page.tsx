'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { ImpactList } from '@/components/assets/impact-list';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { relativeTime } from '@/lib/relative-time';
import { useApiQuery } from '@/lib/use-api-query';

/** Asset detail (spec §21): identity, source, lifecycle, attributes, relationships, blast radius. */
export default function AssetDetailPage() {
  const { orgId, productId, assetId } = useParams<{ orgId: string; productId: string; assetId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const [error, setError] = useState<string | null>(null);
  const p = { params: { path: { id: assetId } } };
  const asset = useApiQuery(['asset', assetId], async () => unwrap(await api.GET('/api/v1/assets/{id}', p)));
  const rels = useApiQuery(['asset-rels', assetId], async () =>
    unwrap(await api.GET('/api/v1/assets/{id}/relationships', p)),
  );
  const impact = useApiQuery(['asset-impact', assetId], async () =>
    unwrap(await api.GET('/api/v1/assets/{id}/impact', p)),
  );
  const base = `/orgs/${orgId}/products/${productId}/assets`;
  const a = asset.data;
  return (
    <div className="space-y-4">
      <Link href={base} className="text-sm text-muted-foreground hover:underline">
        ← Assets
      </Link>
      {error ? <Alert>{error}</Alert> : null}
      <QueryState query={asset} label="Loading asset">
        {a ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="flex items-center gap-3 text-xl font-semibold">
                  {a.name} <Badge>{a.assetType}</Badge> <Badge>{a.lifecycle}</Badge>
                </h1>
                <p className="text-sm text-muted-foreground">
                  Source {a.source.replace('_', ' ')} · first seen {relativeTime(a.firstSeenAt)} · last seen{' '}
                  {relativeTime(a.lastSeenAt)}
                </p>
              </div>
              {roleCan(role, 'product.manage') && a.lifecycle !== 'retired' ? (
                <Button
                  variant="outline"
                  onClick={async () => {
                    setError(null);
                    try {
                      unwrap(await api.POST('/api/v1/assets/{id}/retire', p));
                      await queryClient.invalidateQueries({ queryKey: ['asset', assetId] });
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  Retire
                </Button>
              ) : null}
            </div>
            <Card className="p-4">
              <CardTitle className="text-sm">Attributes</CardTitle>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {Object.entries(a.attributes ?? {}).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>
        ) : null}
      </QueryState>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Relationships</h2>
        <QueryState query={rels} label="Loading relationships">
          <ul className="space-y-1 text-sm">
            {(rels.data?.relationships ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Badge>{r.type}</Badge>
                {r.direction === 'outgoing' ? '→' : '←'}
                <Link href={`${base}/${r.other.id}`} className="underline-offset-2 hover:underline">
                  {r.other.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {r.verification} · {Math.round(r.confidence * 100)}%
                </span>
              </li>
            ))}
            {rels.data?.relationships.length === 0 ? (
              <li className="text-muted-foreground">No relationships yet.</li>
            ) : null}
          </ul>
        </QueryState>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">If this fails</h2>
        <QueryState query={impact} label="Loading impact">
          <ImpactList impact={impact.data?.impact ?? []} />
        </QueryState>
      </section>
    </div>
  );
}
