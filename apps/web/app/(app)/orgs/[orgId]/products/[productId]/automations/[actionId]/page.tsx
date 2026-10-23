'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { unwrap } from '@pcp/api-client';
import { ActionDetail } from '@/components/actions/action-detail';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { useApiQuery } from '@/lib/use-api-query';

export default function ActionPage() {
  const { orgId, productId, actionId } = useParams<{ orgId: string; productId: string; actionId: string }>();
  const action = useApiQuery(
    ['action', actionId],
    async () => unwrap(await api.GET('/api/v1/actions/{id}', { params: { path: { id: actionId } } })),
    {
      refetchInterval: (q) => (['executing', 'approved'].includes(q.state.data?.status ?? '') ? 3000 : false),
    },
  );
  const policies = useApiQuery(['action-policies', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{id}/action-policies', { params: { path: { id: productId } } })),
  );
  const a = action.data;
  const impact = (a?.impact ?? {}) as { summary?: string; host?: string };
  const production =
    policies.data?.policies.find((p) => p.environmentId === a?.environmentId)?.production ?? false;
  return (
    <div className="space-y-4">
      <Link href={`/orgs/${orgId}/products/${productId}/automations`} className="text-sm underline">
        All actions
      </Link>
      <QueryState query={action} label="Loading action">
        {a ? (
          <ActionDetail
            action={{
              id: a.id,
              capability: a.capability,
              params: a.params,
              host: impact.host ?? null,
              status: a.status,
              proposedByAi: a.proposedByAi,
              requestedByUserId: a.requestedByUserId ?? null,
              production,
              impactSummary: impact.summary ?? null,
              createdAt: a.createdAt,
              reason: a.reason ?? null,
              approvals: (a.approvals ?? []).map((p) => ({
                id: p.id ?? '',
                userId: p.userId ?? '',
                decision: p.decision ?? 'approve',
                note: p.note ?? null,
                createdAt: p.createdAt ?? a.createdAt,
              })),
              executions: (a.executions ?? []).map((e) => ({
                id: e.id,
                location: e.location,
                adapter: e.adapter,
                adapterVersion: e.adapterVersion,
                status: e.status,
                startedAt: e.startedAt,
                finishedAt: e.finishedAt ?? null,
                verification: (e.verification ?? null) as {
                  activeState?: string | null;
                  verified?: boolean;
                } | null,
                error: e.error ?? null,
              })),
            }}
          />
        ) : null}
      </QueryState>
    </div>
  );
}
