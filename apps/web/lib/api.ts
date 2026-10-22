import { ApiError, createApiClient } from '@pcp/api-client';

/** Same-origin API client; Caddy (and `next dev` rewrites) route /api to the Control API. */
export const api = createApiClient();

export interface RouterLike {
  replace(href: string): void;
}

/**
 * Central reaction to API errors (the API is the only authority):
 * 401 → sign in and come back; 403 mfa_required → MFA; anything else → the page renders it.
 * Returns null when it navigated away.
 */
export function handleApiError(error: unknown, router: RouterLike, pathname: string): unknown {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return null;
    }
    if (error.status === 403 && error.code === 'mfa_required') {
      router.replace('/mfa');
      return null;
    }
  }
  return error;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'Cannot reach the server. Check your connection and try again.';
  return 'Something went wrong.';
}
