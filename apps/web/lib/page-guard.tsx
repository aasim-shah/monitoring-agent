'use client';

import { ApiError } from '@pcp/api-client';
import type { ReactNode } from 'react';
import { ErrorState } from '@/components/states/error-state';
import { Loading } from '@/components/states/loading';
import { NotFoundState } from '@/components/states/not-found-state';

/** Renders loading / not-found / error states for a query, or the children when data is ready. */
export function QueryState({
  query,
  label,
  children,
}: {
  query: {
    isPending: boolean;
    visibleError: unknown;
    error: unknown;
    refetch: () => unknown;
    data?: unknown;
  };
  label: string;
  children: ReactNode;
}) {
  if (query.visibleError instanceof ApiError && query.visibleError.status === 404) return <NotFoundState />;
  if (query.visibleError) return <ErrorState error={query.visibleError} onRetry={() => query.refetch()} />;
  if (query.isPending || query.error || query.data === undefined) return <Loading label={label} />;
  return <>{children}</>;
}
