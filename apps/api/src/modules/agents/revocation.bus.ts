import type { Redis } from 'ioredis';
import type { AgentIdentityCache } from './agent-identity.cache.js';

const CHANNEL = 'agent-revoked';

/**
 * Broadcasts revoked certificate fingerprints so every API process drops them from its
 * identity cache at once, instead of waiting out the 30 s TTL.
 */
export class RevocationBus {
  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly cache: AgentIdentityCache,
  ) {
    subscriber.subscribe(CHANNEL).catch(() => {});
    subscriber.on('message', (channel, message) => {
      if (channel !== CHANNEL) return;
      try {
        this.cache.evict(JSON.parse(message) as string[]);
      } catch {
        // Malformed message: the 30 s TTL still bounds revocation.
      }
    });
  }

  async publish(fingerprints: string[]): Promise<void> {
    this.cache.evict(fingerprints);
    if (fingerprints.length) await this.publisher.publish(CHANNEL, JSON.stringify(fingerprints));
  }

  close(): void {
    this.subscriber.disconnect();
  }
}
