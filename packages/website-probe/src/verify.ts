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
