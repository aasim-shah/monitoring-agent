import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { Redis } from 'ioredis';
import type { KeyRing } from '@pcp/secrets';
import { CLOCK, KEY_RING, PRISMA, REDIS } from '../../tokens.js';
import { RateLimiter } from '../identity/rate-limiter.js';
import { AgentAuthGuard } from './agent-auth.guard.js';
import { AgentTasksController } from './agent-tasks.controller.js';
import { AgentIdentityCache } from './agent-identity.cache.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { EnrollController } from './enroll.controller.js';
import { EnrollService } from './enroll.service.js';
import { EnrollmentsController } from './enrollments.controller.js';
import { EnrollmentsService } from './enrollments.service.js';
import { HeartbeatController } from './heartbeat.controller.js';
import { InternalAgentsController } from './internal.controller.js';
import { AGENT_SETTINGS, agentSettingsProvider } from './settings.provider.js';
import { RevocationBus } from './revocation.bus.js';
import { RotateController } from './rotate.controller.js';
import { TaskNotifier } from './task-notifier.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';
import { EnrollmentTokens } from './tokens.js';
import { WhoamiController } from './whoami.controller.js';

@Injectable()
class RevocationShutdown implements OnApplicationShutdown {
  constructor(private readonly bus: RevocationBus) {}
  onApplicationShutdown() {
    this.bus.close();
  }
}

@Module({
  controllers: [
    EnrollmentsController,
    EnrollController,
    WhoamiController,
    HeartbeatController,
    AgentsController,
    TasksController,
    AgentTasksController,
    RotateController,
    InternalAgentsController,
  ],
  providers: [
    agentSettingsProvider,
    {
      provide: EnrollmentTokens,
      inject: [KEY_RING],
      useFactory: (k: KeyRing) => new EnrollmentTokens(k.active.key),
    },
    { provide: RateLimiter, inject: [REDIS], useFactory: (redis: Redis) => new RateLimiter(redis) },
    {
      provide: AgentIdentityCache,
      inject: [PRISMA, CLOCK],
      useFactory: (prisma: PrismaClient, now: () => Date) => new AgentIdentityCache(prisma, now),
    },
    AgentAuthGuard,
    EnrollmentsService,
    EnrollService,
    AgentsService,
    {
      provide: TaskNotifier,
      inject: [REDIS],
      useFactory: (redis: Redis) => new TaskNotifier(redis, redis.duplicate()),
    },
    TasksService,
    {
      provide: RevocationBus,
      inject: [REDIS, AgentIdentityCache],
      useFactory: (redis: Redis, cache: AgentIdentityCache) =>
        new RevocationBus(redis, redis.duplicate(), cache),
    },
    RevocationShutdown,
  ],
  exports: [AgentAuthGuard, TasksService, AGENT_SETTINGS, AgentsService],
})
export class AgentsModule {}
