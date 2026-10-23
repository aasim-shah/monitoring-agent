/** Live tail (log_tail tasks) arrived with agent 0.2.0 (M11). */
export const MINIMUM_TAIL_AGENT_VERSION = '0.2.0';

const parse = (v: string) => (/^\d+(\.\d+){0,2}$/.test(v) ? v.split('.').map(Number) : null);

export function supportsLiveTail(version: string): boolean {
  const have = parse(version);
  if (!have) return false;
  const need = parse(MINIMUM_TAIL_AGENT_VERSION)!;
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = need[i]!;
    if (a !== b) return a > b;
  }
  return true;
}
