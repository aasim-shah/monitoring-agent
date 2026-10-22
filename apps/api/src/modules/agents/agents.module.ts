import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { KeyRing } from '@pcp/secrets';
import { KEY_RING, REDIS } from '../../tokens.js';
import { RateLimiter } from '../identity/rate-limiter.js';
import { EnrollController } from './enroll.controller.js';
import { EnrollService } from './enroll.service.js';
import { EnrollmentsController } from './enrollments.controller.js';
import { EnrollmentsService } from './enrollments.service.js';
import { agentSettingsProvider } from './settings.provider.js';
import { EnrollmentTokens } from './tokens.js';

@Module({
  controllers: [EnrollmentsController, EnrollController],
  providers: [
    agentSettingsProvider,
    {
      provide: EnrollmentTokens,
      inject: [KEY_RING],
      useFactory: (k: KeyRing) => new EnrollmentTokens(k.active.key),
    },
    { provide: RateLimiter, inject: [REDIS], useFactory: (redis: Redis) => new RateLimiter(redis) },
    EnrollmentsService,
    EnrollService,
  ],
})
export class AgentsModule {}
