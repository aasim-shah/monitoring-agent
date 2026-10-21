import type { Redis } from 'ioredis';

/** Fixed-window counter in Redis, shared by all API replicas. */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async hit(
    key: string,
    limit = 10,
    windowSeconds = 60,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const now = this.nowSeconds();
    const bucket = Math.floor(now / windowSeconds);
    const redisKey = `rl:${key}:${bucket}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) await this.redis.expire(redisKey, windowSeconds);
    return { allowed: count <= limit, retryAfterSeconds: windowSeconds - (now % windowSeconds) };
  }
}
