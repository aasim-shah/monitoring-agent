import type { Redis } from 'ioredis';

type Listener = (message: string) => void;

/**
 * Delivers `stream:<sessionId>` messages to in-process listeners: one Redis subscriber per
 * API process, whichever process received the agent's chunk publishes it (spec §11.8).
 */
export class StreamRelay {
  private readonly listeners = new Map<string, Listener>();

  constructor(private readonly subscriber: Redis) {
    subscriber.on('message', (channel: string, message: string) => this.listeners.get(channel)?.(message));
  }

  /** Subscribes before resolving, so nothing published afterwards is missed. */
  async listen(sessionId: string, listener: Listener): Promise<() => Promise<void>> {
    const channel = `stream:${sessionId}`;
    this.listeners.set(channel, listener);
    await this.subscriber.subscribe(channel);
    return async () => {
      this.listeners.delete(channel);
      await this.subscriber.unsubscribe(channel).catch(() => {});
    };
  }

  close(): void {
    this.listeners.clear();
    this.subscriber.disconnect();
  }
}
