import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@pcp/api-client';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Client errors (4xx) are answers, not glitches: never retry them.
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
