'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError, unwrap } from '@pcp/api-client';
import { AuditTable } from '@/components/audit/audit-table';
import { ErrorState } from '@/components/states/error-state';
import { Loading } from '@/components/states/loading';
import { NotFoundState } from '@/components/states/not-found-state';
import { api, handleApiError, isNavigationalError } from '@/lib/api';

export default function AuditPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const audit = useInfiniteQuery({
    queryKey: ['audit', orgId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/v1/organizations/{orgId}/audit-logs', {
          params: { path: { orgId }, query: { limit: 50, ...(pageParam ? { before: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  useEffect(() => {
    if (audit.error) handleApiError(audit.error, router, pathname);
  }, [audit.error, router, pathname]);

  if (audit.error && !isNavigationalError(audit.error)) {
    return audit.error instanceof ApiError && audit.error.status === 404 ? (
      <NotFoundState />
    ) : (
      <ErrorState error={audit.error} onRetry={() => audit.refetch()} />
    );
  }
  if (!audit.data) return <Loading label="Loading audit log" />;
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">Audit Log</h1>
      <AuditTable
        entries={audit.data.pages.flatMap((p) => p.entries)}
        hasMore={audit.hasNextPage}
        onLoadMore={() => audit.fetchNextPage()}
        loadingMore={audit.isFetchingNextPage}
      />
    </section>
  );
}
