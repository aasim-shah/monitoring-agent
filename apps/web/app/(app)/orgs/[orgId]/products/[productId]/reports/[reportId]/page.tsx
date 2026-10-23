'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { unwrap } from '@pcp/api-client';
import type { Snapshot } from '@pcp/reports/render';
import type { Role } from '@pcp/shared-contracts';
import { ReportView } from '@/components/reports/report-view';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

export default function ReportPage() {
  const { orgId, productId, reportId } = useParams<{ orgId: string; productId: string; reportId: string }>();
  const org = useOrganization(orgId);
  const report = useApiQuery(['report', reportId], async () =>
    unwrap(await api.GET('/api/v1/reports/{id}', { params: { path: { id: reportId } } })),
  );
  const r = report.data;
  return (
    <div className="space-y-4">
      <Link href={`/orgs/${orgId}/products/${productId}/reports`} className="text-sm underline">
        All reports
      </Link>
      <QueryState query={report} label="Loading report">
        {r ? (
          <ReportView
            report={{
              id: r.id,
              localDate: r.localDate,
              version: r.version,
              timezone: r.timezone,
              windowStart: r.windowStart,
              windowEnd: r.windowEnd,
              narrative: r.narrative ?? null,
              narrativeStatus: r.narrativeStatus,
              problems: r.problems ?? [],
              late: r.late,
              scheduleName: r.scheduleName ?? null,
              snapshot: r.snapshot as unknown as Snapshot,
              deliveries: r.deliveries.map((d) => ({
                id: d.id,
                kind: d.kind,
                target: d.target,
                status: d.status,
                attempts: d.attempts,
                lastError: d.lastError ?? null,
                sentAt: d.sentAt ?? null,
              })),
            }}
            canManage={roleCan((org.data?.role ?? 'viewer') as Role, 'report.manage')}
            onRegenerate={async () => {
              unwrap(
                await api.POST('/api/v1/reports/{id}/regenerate', { params: { path: { id: reportId } } }),
              );
            }}
          />
        ) : null}
      </QueryState>
    </div>
  );
}
