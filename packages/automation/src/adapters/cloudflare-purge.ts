import type { AdapterResult, HttpLike } from './http.js';

export const CLOUDFLARE_PURGE_VERSION = '1';

/**
 * Cloudflare cache purge (UC-16-06) for one zone: a URL list, or everything (two approvals).
 * Verification is the API's success flag; a purge cannot be undone, the cache refills on demand.
 */
export async function cloudflarePurge(
  http: HttpLike,
  input: {
    token: string;
    zoneId: string;
    params: { urls?: string[]; everything?: boolean };
    baseUrl?: string;
  },
): Promise<AdapterResult> {
  const base = input.baseUrl ?? 'https://api.cloudflare.com/client/v4';
  const body = input.params.everything ? { purge_everything: true } : { files: input.params.urls ?? [] };
  const res = await http.request(`${base}/zones/${encodeURIComponent(input.zoneId)}/purge_cache`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (() => {
    try {
      return res.json<{
        success?: boolean;
        errors?: Array<{ message?: string }>;
        result?: { id?: string };
      }>();
    } catch {
      return {};
    }
  })();
  if (res.status >= 200 && res.status < 300 && payload.success)
    return { ok: true, result: { purgeId: payload.result?.id ?? null }, verification: { apiSuccess: true } };
  const message =
    payload.errors
      ?.map((e) => e.message)
      .filter(Boolean)
      .join('; ') || 'request failed';
  return { ok: false, error: `Cloudflare answered ${res.status}: ${message}` };
}
