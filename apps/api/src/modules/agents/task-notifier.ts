import type { Redis } from 'ioredis';

const CHANNEL = 'agent-tasks:';

/**
 * Wakes long-polling agents (D14) when a task is created on any API process: one Redis
 * subscriber per process, and in-process waiters keyed by agent ID.
 */
export class TaskNotifier {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {
    // Rejects if the app shuts down before subscribing; nothing waits on it then.
    subscriber.psubscribe(`${CHANNEL}*`).catch(() => {});
    subscriber.on('pmessage', (_pattern, channel) => this.wake(channel.slice(CHANNEL.length)));
  }

  async notify(agentId: string): Promise<void> {
    await this.publisher.publish(`${CHANNEL}${agentId}`, '1');
  }

  /** Resolves when a task for the agent is announced, after `ms`, or when `signal` aborts. */
  wait(agentId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const set = this.waiters.get(agentId) ?? new Set();
      this.waiters.set(agentId, set);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(agentId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      set.add(done);
    });
  }

  close(): void {
    for (const set of this.waiters.values()) for (const done of [...set]) done();
    this.subscriber.disconnect();
  }

  private wake(agentId: string): void {
    for (const done of [...(this.waiters.get(agentId) ?? [])]) done();
  }
}
