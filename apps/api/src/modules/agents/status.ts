const DEGRADED_AFTER_MS = 90_000;
const STALE_AFTER_MS = 300_000;

export type DerivedAgentStatus = 'active' | 'degraded' | 'revoked';

/**
 * Display status from the stored state and heartbeat age (spec §8.2, master plan §3):
 * degraded after 90 s without a heartbeat, stale after 5 min. Before the first heartbeat
 * the enrollment time counts as the last sign of life.
 */
export function agentStatus(
  a: { status: 'active' | 'revoked'; lastHeartbeatAt: Date | null; createdAt: Date },
  now: Date,
): { status: DerivedAgentStatus; stale: boolean } {
  if (a.status === 'revoked') return { status: 'revoked', stale: false };
  const age = now.getTime() - (a.lastHeartbeatAt ?? a.createdAt).getTime();
  return { status: age > DEGRADED_AFTER_MS ? 'degraded' : 'active', stale: age > STALE_AFTER_MS };
}
