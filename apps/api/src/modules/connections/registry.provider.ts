import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { ConnectorRuntime, buildRegistry } from '@pcp/connector-runtime';
import type { ConnectorRegistry } from '@pcp/connector-sdk';
import type { PrismaClient } from '@pcp/database';
import { createQueues, type Queues } from '@pcp/jobs';
import type { KeyRing } from '@pcp/secrets';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG, CLOCK, KEY_RING, PRISMA } from '../../tokens.js';

export const CONNECTOR_REGISTRY = Symbol('CONNECTOR_REGISTRY');
export const CONNECTOR_RUNTIME = Symbol('CONNECTOR_RUNTIME');
export const QUEUES = Symbol('QUEUES');

/** Registry, runtime, and job queues for the connections module. The mock connector loads only in tests. */
export function connectorProviders(env: Record<string, string | undefined>): Provider[] {
  return [
    { provide: CONNECTOR_REGISTRY, useFactory: () => buildRegistry(env) },
    {
      provide: CONNECTOR_RUNTIME,
      inject: [PRISMA, CONNECTOR_REGISTRY, KEY_RING, CLOCK],
      useFactory: (prisma: PrismaClient, registry: ConnectorRegistry, keys: KeyRing, now: () => Date) =>
        new ConnectorRuntime(prisma, registry, keys, now),
    },
    { provide: QUEUES, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createQueues(c.redisUrl) },
    QueuesShutdown,
  ];
}

@Injectable()
class QueuesShutdown implements OnApplicationShutdown {
  constructor(@Inject(QUEUES) private readonly queues: Queues) {}
  async onApplicationShutdown() {
    await this.queues.close();
  }
}
