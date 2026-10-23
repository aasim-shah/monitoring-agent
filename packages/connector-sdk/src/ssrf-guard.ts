import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ConnectorError } from './errors.js';

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export interface DestinationOptions {
  /** Private execution (worker inside the customer network): allowlisted private targets only. */
  allowPrivate: boolean;
  /** `host` or `host:port` entries; IP literals or hostnames. */
  allowlist?: string[];
  lookup?: LookupFn;
}

/** Ranges never reachable from central execution (BR-07-06). */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  PRIVATE.addSubnet(net, prefix, 'ipv6');

/** Link-local metadata endpoints stay blocked even for allowlisted private execution. */
const ALWAYS = new BlockList();
ALWAYS.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS.addSubnet('fe80::', 10, 'ipv6');
ALWAYS.addAddress('0.0.0.0', 'ipv4');
ALWAYS.addAddress('::', 'ipv6');

const blocked = (reason: string) =>
  new ConnectorError('destination_blocked', `destination refused: ${reason}`);

/** `::ffff:10.0.0.1` is 10.0.0.1. */
function normalize(address: string): { address: string; family: 4 | 6 } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1]!, family: 4 };
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}

const inList = (list: BlockList, a: { address: string; family: 4 | 6 }) =>
  list.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4');

/** True for an address central execution may contact (not private, loopback, or link-local). */
export function isPublicAddress(address: string): boolean {
  const a = normalize(address);
  return isIP(a.address) !== 0 && !inList(ALWAYS, a) && !inList(PRIVATE, a);
}

const defaultLookup: LookupFn = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));

/**
 * Resolves the URL's host once and returns the address to connect to (master plan M8.3).
 * Every resolved address must pass: a public-looking hostname that also resolves to a
 * private address is refused. Callers connect to the returned address only, so a second
 * (rebinding) lookup can never redirect the request.
 */
export async function assertPublicDestination(
  url: URL,
  opts: DestinationOptions,
): Promise<{ address: string; family: 4 | 6 }> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw blocked(`scheme ${url.protocol}`);
  if (url.username || url.password) throw blocked('credentials in URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const literal = isIP(host) !== 0;
  const resolved = (
    literal ? [{ address: host, family: isIP(host) as 4 | 6 }] : await (opts.lookup ?? defaultLookup)(host)
  ).map((a) => normalize(a.address));
  if (resolved.length === 0) throw blocked(`${host} does not resolve`);
  const allowlisted =
    opts.allowPrivate &&
    (opts.allowlist ?? []).some((entry) => entry === host || entry === `${host}:${port}`);
  for (const a of resolved) {
    if (inList(ALWAYS, a)) throw blocked(`${a.address} is link-local or unspecified`);
    if (inList(PRIVATE, a) && !allowlisted) throw blocked(`${a.address} is a private address`);
  }
  return resolved[0]!;
}
