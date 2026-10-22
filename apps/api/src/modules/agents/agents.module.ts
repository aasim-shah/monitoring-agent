import { Module } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { Redis } from 'ioredis';
import type { KeyRing } from '@pcp/secrets';
import { CLOCK, KEY_RING, PRISMA, REDIS } from '../../tokens.js';
import { RateLimiter } from '../identity/rate-limiter.js';
import { AgentAuthGuard } from './agent-auth.guard.js';
import { AgentIdentityCache } from './agent-identity.cache.js';
import { EnrollController } from './enroll.controller.js';
import { EnrollService } from './enroll.service.js';
import { EnrollmentsController } from './enrollments.controller.js';
import { EnrollmentsService } from './enrollments.service.js';
import { agentSettingsProvider } from './settings.provider.js';
import { EnrollmentTokens } from './tokens.js';
import { WhoamiController } from './whoami.controller.js';

@Module({
  controllers: [EnrollmentsController, EnrollController, WhoamiController],
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
  ],
  exports: [AgentAuthGuard],
})
export class AgentsModule {}
