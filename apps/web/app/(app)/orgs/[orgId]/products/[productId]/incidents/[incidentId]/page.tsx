'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { IncidentDetail, type IncidentDetailData } from '@/components/alerting/incident-detail';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

export default function IncidentPage() {
  const { orgId, productId, incidentId } = useParams<{
    orgId: string;
    productId: string;
    incidentId: string;
  }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const key = ['incident', incidentId];
  const detail = useApiQuery(
    key,
    async () => unwrap(await api.GET('/api/v1/incidents/{id}', { params: { path: { id: incidentId } } })),
    { refetchInterval: 30_000 },
  );
  const refresh = (data: unknown) => {
    queryClient.setQueryData(key, data);
  };
  const path = { params: { path: { id: incidentId } } };
  return (
    <section className="space-y-4">
      <Link
        className="text-sm text-primary hover:underline"
        href={`/orgs/${orgId}/products/${productId}/incidents`}
      >
        ← Incidents
      </Link>
      <QueryState query={detail} label="Loading incident">
        {detail.data ? (
          <IncidentDetail
            data={detail.data as unknown as IncidentDetailData}
            canManage={roleCan(role, 'incident.manage')}
            onAcknowledge={async () =>
              refresh(unwrap(await api.POST('/api/v1/incidents/{id}/acknowledge', path)))
            }
            onResolve={async (note) =>
              refresh(
                unwrap(
                  await api.POST('/api/v1/incidents/{id}/resolve', { ...path, body: note ? { note } : {} }),
                ),
              )
            }
            onPostmortem={async (body) =>
              refresh(unwrap(await api.PATCH('/api/v1/incidents/{id}/postmortem', { ...path, body })))
            }
          />
        ) : null}
      </QueryState>
    </section>
  );
}
