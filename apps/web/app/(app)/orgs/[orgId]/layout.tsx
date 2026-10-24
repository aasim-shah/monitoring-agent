'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Role } from '@pcp/shared-contracts';
import { ContextSwitcher } from '@/components/shell/context-switcher';
import { SideNav } from '@/components/shell/side-nav';
import { ErrorState } from '@/components/states/error-state';
import { Loading } from '@/components/states/loading';
import { NotFoundState } from '@/components/states/not-found-state';
import { ApiError, unwrap } from '@pcp/api-client';
import { DeletionBanner } from '@/components/orgs/tenant-data';
import { LimitBanner } from '@/components/usage/usage-view';
import { api } from '@/lib/api';
import { roleCan } from '@/lib/permissions';
import { buildOrgNav, buildProductNav } from '@/lib/nav';
import { useOrganization } from '@/lib/queries';

export default function OrganizationLayout({ children }: { children: ReactNode }) {
  const { orgId, productId } = useParams<{ orgId: string; productId?: string }>();
  const org = useOrganization(orgId);
  const queryClient = useQueryClient();

  if (org.isPending || (org.error && !org.visibleError)) return <Loading label="Loading organization" />;
  if (org.visibleError) {
    return org.visibleError instanceof ApiError && org.visibleError.status === 404 ? (
      <NotFoundState />
    ) : (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <ErrorState error={org.visibleError} onRetry={() => org.refetch()} />
      </main>
    );
  }

  if (!org.data) return <Loading label="Loading organization" />;
  const role = (org.data.role ?? 'viewer') as Role;
  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 md:grid-cols-[240px_1fr]">
      <aside className="space-y-6">
        <SideNav title={org.data.name} items={buildOrgNav(orgId, role)} />
        {productId ? <SideNav title="Product" items={buildProductNav(orgId, productId, role)} /> : null}
      </aside>
      <main className="space-y-4">
        <ContextSwitcher orgId={orgId} productId={productId} />
        {org.data.deletionScheduledFor ? (
          <DeletionBanner
            scheduledFor={org.data.deletionScheduledFor}
            canCancel={roleCan(role, 'org.delete')}
            onCancel={async () => {
              unwrap(
                await api.POST('/api/v1/organizations/{orgId}/deletion/cancel', {
                  params: { path: { orgId } },
                }),
              );
              await queryClient.invalidateQueries({ queryKey: ['org', orgId] });
            }}
          />
        ) : null}
        {org.data.telemetryLimitSince ? (
          <LimitBanner since={org.data.telemetryLimitSince} usageHref={`/orgs/${orgId}/usage`} />
        ) : null}
        {children}
      </main>
    </div>
  );
}
