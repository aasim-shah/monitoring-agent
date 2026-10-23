import type { Redis } from 'ioredis';

export const MAX_TAILS_PER_TENANT = 5;
export const MAX_TAILS_PER_AGENT = 2;

// Sorted sets of session IDs scored by expiry: entries past their TTL are dropped first, so a
// crashed API instance cannot hold slots beyond the stream TTL (Review Focus #3).
const RESERVE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 2 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 1 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
return 0
`;

export type Reservation = 'ok' | 'tenant_full' | 'agent_full';

const keys = (organizationId: string, agentId: string) => [
  `logtail:tenant:${organizationId}`,
  `logtail:agent:${agentId}`,
];

/** Concurrent live tails per tenant and per agent (master plan §3). */
export class TailLimits {
  constructor(private readonly redis: Redis) {}

  async reserve(
    organizationId: string,
    agentId: string,
    sessionId: string,
    now: Date,
    ttlMs: number,
  ): Promise<Reservation> {
    const result = await this.redis.eval(
      RESERVE,
      2,
      ...keys(organizationId, agentId),
      now.getTime(),
      now.getTime() + ttlMs,
      sessionId,
      MAX_TAILS_PER_TENANT,
      MAX_TAILS_PER_AGENT,
      ttlMs + 60_000,
    );
    return result === 0 ? 'ok' : result === 1 ? 'tenant_full' : 'agent_full';
  }

  async release(organizationId: string, agentId: string, sessionId: string): Promise<void> {
    const [tenant, agent] = keys(organizationId, agentId);
    await this.redis.multi().zrem(tenant!, sessionId).zrem(agent!, sessionId).exec();
  }
}
