'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { CoverageCards } from '@/components/assets/coverage-cards';
import { InventoryTable } from '@/components/assets/inventory-table';
import { ReviewQueue } from '@/components/assets/review-queue';
import { TopologyGraph } from '@/components/assets/topology-graph';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

const TABS = ['Inventory', 'Review', 'Topology', 'Coverage'] as const;
type Tab = (typeof TABS)[number];

export default function AssetsPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const [tab, setTab] = useState<Tab>('Inventory');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const path = { params: { path: { id: productId } } };
  const assets = useApiQuery(['assets', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{id}/assets', path)),
  );
  const review = useApiQuery(['assets-review', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{id}/review', path)),
  );
  const topology = useApiQuery(['assets-topology', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{id}/topology', path)),
  );
  const coverage = useApiQuery(['assets-coverage', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{id}/coverage', path)),
  );
  const refresh = () =>
    Promise.all(
      ['assets', 'assets-review', 'assets-topology', 'assets-coverage'].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k, productId] }),
      ),
    );
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const toReview = (review.data?.edges.length ?? 0) + (review.data?.aliases.length ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Assets</h1>
          <p className="text-sm text-muted-foreground">
            What this product runs on, discovered from agents, databases, and domains, with evidence for every
            relationship.
          </p>
        </div>
        {roleCan(role, 'product.manage') ? (
          <Button
            disabled={running}
            onClick={() =>
              act(async () => {
                setRunning(true);
                try {
                  unwrap(await api.POST('/api/v1/products/{id}/discovery/run', path));
                } finally {
                  setRunning(false);
                }
              })
            }
          >
            {running ? 'Discovering…' : 'Run discovery'}
          </Button>
        ) : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div role="tablist" aria-label="Asset views" className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}
            onClick={() => setTab(t)}
          >
            {t}
            {t === 'Review' && toReview ? ` (${toReview})` : ''}
          </button>
        ))}
      </div>
      {tab === 'Inventory' ? (
        <QueryState query={assets} label="Loading assets">
          <InventoryTable
            assets={assets.data?.assets ?? []}
            basePath={`/orgs/${orgId}/products/${productId}/assets`}
          />
        </QueryState>
      ) : tab === 'Review' ? (
        <QueryState query={review} label="Loading review queue">
          <ReviewQueue
            edges={review.data?.edges ?? []}
            aliases={review.data?.aliases ?? []}
            canVerify={roleCan(role, 'relationship.verify')}
            canManage={roleCan(role, 'product.manage')}
            onVerify={(id) =>
              act(async () =>
                unwrap(await api.POST('/api/v1/relationships/{id}/verify', { params: { path: { id } } })),
              )
            }
            onReject={(id) =>
              act(async () =>
                unwrap(await api.POST('/api/v1/relationships/{id}/reject', { params: { path: { id } } })),
              )
            }
            onResolve={(id, action) =>
              act(async () =>
                unwrap(
                  await api.POST('/api/v1/asset-aliases/{id}/resolve', {
                    params: { path: { id } },
                    body: { action },
                  }),
                ),
              )
            }
          />
        </QueryState>
      ) : tab === 'Topology' ? (
        <QueryState query={topology} label="Loading topology">
          <TopologyGraph
            nodes={topology.data?.nodes ?? []}
            edges={topology.data?.edges ?? []}
            onNodeClick={(id) => router.push(`/orgs/${orgId}/products/${productId}/assets/${id}`)}
          />
        </QueryState>
      ) : (
        <QueryState query={coverage} label="Loading coverage">
          {coverage.data ? <CoverageCards coverage={coverage.data} /> : null}
        </QueryState>
      )}
    </div>
  );
}
