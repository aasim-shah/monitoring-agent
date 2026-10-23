import { Resolver, resolve4, resolveNs, resolveTxt as cachedResolveTxt } from 'node:dns/promises';
import { isPublicAddress } from '@pcp/connector-sdk';

/** Public suffixes with two labels that must never prove control (a small pilot list). */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.in',
  'com.pk',
  'net.pk',
  'org.pk',
  'edu.pk',
  'gov.pk',
  'com.br',
  'com.cn',
  'co.jp',
  'com.sg',
  'com.my',
  'com.tr',
  'co.za',
  'com.mx',
  'com.ar',
  'com.sa',
  'com.eg',
  'co.id',
  'com.ng',
  'com.bd',
  'com.vn',
  'com.ph',
]);

export type ResolveTxt = (name: string) => Promise<string[][]>;

/** Names to check: the host and its parents, never a single label or a known public suffix. */
export function candidateNames(host: string): string[] {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const names: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    if (TWO_LABEL_SUFFIXES.has(name)) break;
    names.push(name);
  }
  return names;
}

/** DNS TXT proof of control (WB-09 UC-09-01): `pcp-verify=<token>` on the host or a parent domain. */
export async function verifyDomain(
  host: string,
  token: string,
  resolveTxt: ResolveTxt,
): Promise<{ verified: boolean; checkedNames: string[] }> {
  const checkedNames: string[] = [];
  for (const name of candidateNames(host)) {
    checkedNames.push(name);
    try {
      const records = await resolveTxt(name);
      if (records.some((chunks) => chunks.join('').trim() === `pcp-verify=${token}`))
        return { verified: true, checkedNames };
    } catch {
      // No TXT record at this name: keep walking up.
    }
  }
  return { verified: false, checkedNames };
}

export interface DnsLookups {
  resolveNs(name: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
  /** TXT records asked directly of these nameserver addresses. */
  resolveTxtAt(servers: string[], name: string): Promise<string[][]>;
  /** The caching resolver, used when the nameservers do not answer. */
  resolveTxt: ResolveTxt;
}

/** "This name has no such record": an answer, not a failure to ask. */
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND']);

async function zoneNameservers(name: string, dns: DnsLookups): Promise<string[]> {
  const labels = name.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    try {
      const ns = await dns.resolveNs(labels.slice(i).join('.'));
      if (ns.length) return ns;
    } catch {
      // Not a zone apex: try the parent.
    }
  }
  return [];
}

/**
 * TXT lookups from the zone's own nameservers (WB-09 UC-09-01): a record added minutes ago is
 * found even while caching resolvers still serve the old TXT set for up to its TTL. Only public
 * nameserver addresses are queried; when they cannot be asked, the caching resolver answers.
 */
export function authoritativeTxt(dns: DnsLookups): ResolveTxt {
  return async (name) => {
    const hosts = (await zoneNameservers(name, dns)).slice(0, 4);
    const servers = (await Promise.all(hosts.map((h) => dns.resolve4(h).catch(() => []))))
      .flat()
      .filter(isPublicAddress);
    if (servers.length) {
      try {
        return await dns.resolveTxtAt(servers, name);
      } catch (err) {
        if (NO_RECORD.has((err as { code?: string }).code ?? '')) throw err;
      }
    }
    return dns.resolveTxt(name);
  };
}

/** Node's resolver: nameservers asked over UDP with a 3 s timeout, one try each. */
export const nodeDns: DnsLookups = {
  resolveNs,
  resolve4,
  resolveTxtAt: (servers, name) => {
    const r = new Resolver({ timeout: 3000, tries: 1 });
    r.setServers(servers);
    return r.resolveTxt(name);
  },
  resolveTxt: cachedResolveTxt,
};
