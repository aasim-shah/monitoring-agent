/**
 * When a website's domain registration expires, from the registry's public RDAP record (via the
 * rdap.org bootstrap redirector). Read once per domain per day; null when the registry does not
 * publish a date or does not answer, never a guess.
 */
const TIMEOUT_MS = 5_000;
/** Second-level labels that sit under a country code (example.co.uk, store.com.pk). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ltd', 'plc', 'me', 'biz']);

export function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1]!)) return null;
  const [sld, tld] = labels.slice(-2) as [string, string];
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) && labels.length >= 3 ? 3 : 2;
  return labels.slice(-take).join('.');
}

const cache = new Map<string, Promise<string | null>>();

export function domainExpiry(host: string, at: Date, fetcher: typeof fetch = fetch): Promise<string | null> {
  const domain = registrableDomain(host);
  if (!domain) return Promise.resolve(null);
  const key = `${domain}:${at.toISOString().slice(0, 10)}`;
  if (!cache.has(key)) {
    if (cache.size > 500) cache.clear();
    cache.set(
      key,
      (async () => {
        try {
          const res = await fetcher(`https://rdap.org/domain/${domain}`, {
            headers: { accept: 'application/rdap+json' },
            redirect: 'follow',
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) return null;
          const body = (await res.json()) as { events?: Array<{ eventAction?: string; eventDate?: string }> };
          const date = body.events?.find((e) => e.eventAction === 'expiration')?.eventDate;
          const t = date ? Date.parse(date) : NaN;
          return Number.isFinite(t) ? new Date(t).toISOString() : null;
        } catch {
          return null;
        }
      })(),
    );
  }
  return cache.get(key)!;
}
