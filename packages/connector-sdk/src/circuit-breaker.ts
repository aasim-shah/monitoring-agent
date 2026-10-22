import { ConnectorError } from './errors.js';

/** Per-provider circuit breaker: opens after consecutive failures, retries one trial after a cool-down. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private readonly threshold: number;
  private readonly resetAfterMs: number;
  private readonly now: () => number;

  constructor(opts: { failureThreshold?: number; resetAfterMs?: number; now?: () => number } = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.resetAfterMs = opts.resetAfterMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.openUntil > this.now()) {
      throw new ConnectorError('provider_unavailable', 'provider temporarily unavailable (circuit open)');
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (err) {
      this.failures += 1;
      // A failed half-open trial (after a previous open) reopens immediately.
      if (this.failures >= this.threshold || this.openUntil !== 0)
        this.openUntil = this.now() + this.resetAfterMs;
      throw err;
    }
  }
}
