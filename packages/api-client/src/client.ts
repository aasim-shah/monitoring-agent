import createClient from 'openapi-fetch';
import type { paths } from './schema.js';

/** Same-origin client for the Control API; the session cookie travels automatically. */
export function createApiClient(opts: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  return createClient<paths>({
    baseUrl: opts.baseUrl ?? '',
    credentials: 'include',
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
