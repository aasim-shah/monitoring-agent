import { describe, expect, it, vi } from 'vitest';
import { authoritativeTxt, type DnsLookups } from './verify.js';

const err = (code: string) => Object.assign(new Error(code), { code });

/** getrestro.com: the authoritative server has the new record; the caching resolver does not yet. */
function fakeDns(over: Partial<DnsLookups> = {}): DnsLookups {
  return {
    resolveNs: async (name) => {
      if (name === 'getrestro.com') return ['ns1.dns-parking.com', 'ns2.dns-parking.com'];
      throw err('ENODATA');
    },
    resolve4: async (host) =>
      ({ 'ns1.dns-parking.com': ['162.159.24.201'], 'ns2.dns-parking.com': ['162.159.25.123'] })[host] ?? [],
    resolveTxtAt: async (_servers, name) => {
      if (name === 'getrestro.com') return [['google-site-verification=x'], ['pcp-verify=new']];
      throw err('ENODATA');
    },
    resolveTxt: async () => [['google-site-verification=x']],
    ...over,
  };
}

describe('authoritativeTxt (records added minutes ago)', () => {
  it('asks the zone nameservers, so a cached TXT set does not hide a new record', async () => {
    const resolveTxtAt = vi.fn(fakeDns().resolveTxtAt);
    const txt = authoritativeTxt(fakeDns({ resolveTxtAt }));
    expect(await txt('getrestro.com')).toContainEqual(['pcp-verify=new']);
    expect(resolveTxtAt).toHaveBeenCalledWith(['162.159.24.201', '162.159.25.123'], 'getrestro.com');
  });

  it('finds the zone of a subdomain by walking up to its parent', async () => {
    const resolveTxtAt = vi.fn(async () => [['pcp-verify=shop']]);
    const txt = authoritativeTxt(fakeDns({ resolveTxtAt }));
    expect(await txt('shop.getrestro.com')).toEqual([['pcp-verify=shop']]);
    expect(resolveTxtAt).toHaveBeenCalledWith(['162.159.24.201', '162.159.25.123'], 'shop.getrestro.com');
  });

  it('trusts an authoritative "no record" answer', async () => {
    const txt = authoritativeTxt(fakeDns());
    await expect(txt('missing.getrestro.com')).rejects.toMatchObject({ code: 'ENODATA' });
  });

  it('falls back to the caching resolver when the nameservers do not answer', async () => {
    const txt = authoritativeTxt(fakeDns({ resolveTxtAt: async () => Promise.reject(err('ETIMEOUT')) }));
    expect(await txt('getrestro.com')).toEqual([['google-site-verification=x']]);
  });

  it('never sends a query to a nameserver with a private address', async () => {
    const resolveTxtAt = vi.fn(fakeDns().resolveTxtAt);
    const txt = authoritativeTxt(
      fakeDns({ resolve4: async () => ['10.0.0.53', '169.254.169.254'], resolveTxtAt }),
    );
    expect(await txt('getrestro.com')).toEqual([['google-site-verification=x']]);
    expect(resolveTxtAt).not.toHaveBeenCalled();
  });
});
