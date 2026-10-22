// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@pcp/api-client';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }), usePathname: () => '/orgs/abc' }));

const { useApiQuery } = await import('./use-api-query');

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => replace.mockReset());

describe('useApiQuery', () => {
  it('redirects to login on 401 and hides the error (Review Focus #1)', async () => {
    const { result } = renderHook(
      () =>
        useApiQuery(['x'], async () =>
          Promise.reject(new ApiError(401, 'unauthenticated', 'Sign in required')),
        ),
      { wrapper },
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?next=%2Forgs%2Fabc'));
    expect(result.current.visibleError).toBeNull();
  });

  it('exposes other errors to the page', async () => {
    const err = new ApiError(404, 'not_found', 'Not found');
    const { result } = renderHook(() => useApiQuery(['y'], async () => Promise.reject(err)), { wrapper });
    await waitFor(() => expect(result.current.visibleError).toBe(err));
    expect(replace).not.toHaveBeenCalled();
  });

  it('returns data on success', async () => {
    const { result } = renderHook(() => useApiQuery(['z'], async () => ({ ok: true })), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ ok: true }));
  });
});
