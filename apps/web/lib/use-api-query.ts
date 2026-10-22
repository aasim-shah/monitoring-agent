'use client';

import { useQuery, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { handleApiError, isNavigationalError } from './api';

/**
 * TanStack Query plus the shared API error policy: 401 → login, mfa_required → /mfa.
 * `visibleError` holds only errors the page should render.
 */
export function useApiQuery<T>(
  key: QueryKey,
  fn: () => Promise<T>,
  options: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'> = {},
) {
  const router = useRouter();
  const pathname = usePathname();
  const query = useQuery<T>({ queryKey: key, queryFn: fn, ...options });
  useEffect(() => {
    if (query.error) handleApiError(query.error, router, pathname);
  }, [query.error, router, pathname]);
  return { ...query, visibleError: query.error && !isNavigationalError(query.error) ? query.error : null };
}
