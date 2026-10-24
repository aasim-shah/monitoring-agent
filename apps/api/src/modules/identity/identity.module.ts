import { Module } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { Redis } from 'ioredis';
import { CLOCK, PRISMA, REDIS } from '../../tokens.js';
import { AuthController, MeController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CurrentUserGuard } from './current-user.guard.js';
import { GOOGLE_HTTP, GoogleLoginService, defaultGoogleHttp } from './google-login.service.js';
import { MfaService } from './mfa.service.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController, MeController],
  providers: [
    {
      provide: SessionService,
      inject: [PRISMA, CLOCK],
      useFactory: (prisma: PrismaClient, clock: () => Date) => new SessionService(prisma, clock),
    },
    { provide: RateLimiter, inject: [REDIS], useFactory: (redis: Redis) => new RateLimiter(redis) },
    { provide: GOOGLE_HTTP, useFactory: defaultGoogleHttp },
    AuthService,
    MfaService,
    GoogleLoginService,
    CurrentUserGuard,
  ],
  exports: [SessionService, CurrentUserGuard, GOOGLE_HTTP],
})
export class IdentityModule {}
