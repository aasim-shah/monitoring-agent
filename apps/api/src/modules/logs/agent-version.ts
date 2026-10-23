/** Live tail (log_tail tasks) arrived with agent 0.2.0 (M11). */
export const MINIMUM_TAIL_AGENT_VERSION = '0.2.0';

const parse = (v: string) => (/^\d+(\.\d+){0,2}$/.test(v) ? v.split('.').map(Number) : null);

/** Actions through pcp-helper (action tasks) arrived with agent 0.3.0 (M16). */
export const MINIMUM_ACTION_AGENT_VERSION = '0.3.0';

export function supportsLiveTail(version: string): boolean {
  return atLeast(version, MINIMUM_TAIL_AGENT_VERSION);
}

export function atLeast(version: string, minimum: string): boolean {
  const have = parse(version);
  if (!have) return false;
  const need = parse(minimum)!;
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = need[i]!;
    if (a !== b) return a > b;
  }
  return true;
}
