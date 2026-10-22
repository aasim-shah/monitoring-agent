import type { PrismaClient } from '@pcp/database';

export interface AgentCredentialState {
  agent_id: string;
  organization_id: string;
  product_id: string;
  environment_id: string;
  agent_status: 'active' | 'revoked';
  not_after: Date;
  superseded_at: Date | null;
  credential_revoked_at: Date | null;
}

const TTL_MS = 30_000;
/** A rotated-out certificate keeps working this long (§3). */
export const ROTATION_GRACE_MS = 3600_000;

/**
 * Fingerprint → credential state, cached for at most 30 s so revocation takes effect
 * within that window on every API process (BR-03-05). Unknown fingerprints are cached too.
 */
export class AgentIdentityCache {
  private readonly entries = new Map<string, { state: AgentCredentialState | null; expires: number }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date,
  ) {}

  async get(fingerprint: string): Promise<AgentCredentialState | null> {
    const t = this.now().getTime();
    const hit = this.entries.get(fingerprint);
    if (hit && hit.expires > t) return hit.state;
    const [state] = await this.prisma.$queryRaw<AgentCredentialState[]>`
      SELECT * FROM pcp_agent_by_fingerprint(${fingerprint})`;
    if (this.entries.size > 10_000) this.entries.clear();
    this.entries.set(fingerprint, { state: state ?? null, expires: t + TTL_MS });
    return state ?? null;
  }

  evict(fingerprints: string[]): void {
    for (const f of fingerprints) this.entries.delete(f);
  }

  /** Whether the credential may authenticate at this moment. */
  static valid(s: AgentCredentialState, now: Date): boolean {
    const t = now.getTime();
    return (
      s.agent_status === 'active' &&
      s.credential_revoked_at === null &&
      t < s.not_after.getTime() &&
      (s.superseded_at === null || t < s.superseded_at.getTime() + ROTATION_GRACE_MS)
    );
  }
}
