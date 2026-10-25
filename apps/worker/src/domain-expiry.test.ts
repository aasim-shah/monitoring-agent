import { describe, expect, it } from 'vitest';
import { domainExpiry, registrableDomain } from './domain-expiry.js';

const rdap = (expires: string | null, status = 200) =>
  (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        events: [
          { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
          ...(expires ? [{ eventAction: 'expiration', eventDate: expires }] : []),
        ],
      }),
      { status },
    );
  }) as typeof fetch;
let calls: string[] = [];

describe('domain expiry (RDAP)', () => {
  it('finds the registered domain behind a host', () => {
    expect(registrableDomain('www.runmypharmacy.com')).toBe('runmypharmacy.com');
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('app.store.com.pk')).toBe('store.com.pk');
    expect(registrableDomain('localhost')).toBeNull();
    expect(registrableDomain('10.0.0.1')).toBeNull();
  });

  it('reads the expiration date and caches it per domain for the day', async () => {
    calls = [];
    const f = rdap('2026-11-14T10:00:00Z');
    const at = new Date('2026-10-25T03:00:00Z');
    expect(await domainExpiry('www.runmypharmacy.com', at, f)).toBe('2026-11-14T10:00:00.000Z');
    expect(await domainExpiry('runmypharmacy.com', at, f)).toBe('2026-11-14T10:00:00.000Z');
    expect(calls).toEqual(['https://rdap.org/domain/runmypharmacy.com']);
  });

  it('is null when the registry has no date or does not answer', async () => {
    const at = new Date('2026-10-25T03:00:00Z');
    expect(await domainExpiry('nodate.example', at, rdap(null))).toBeNull();
    expect(await domainExpiry('missing.example', at, rdap(null, 404))).toBeNull();
    const broken = (async () => {
      throw new Error('timeout');
    }) as typeof fetch;
    expect(await domainExpiry('down.example', at, broken)).toBeNull();
  });
});
