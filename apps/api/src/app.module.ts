import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { postgresCheck, redisCheck } from '@pcp/health';
import { loadKeyRing } from '@pcp/secrets';
import { ApiExceptionFilter } from './common/errors.js';
import { OriginGuard } from './common/origin.guard.js';
import { TenantGuard } from './common/tenant.guard.js';
import type { AppConfig } from './config.js';
import { DatabaseModule } from './database/database.module.js';
import { AgentAuthGuard } from './modules/agents/agent-auth.guard.js';
import { AgentsModule } from './modules/agents/agents.module.js';
import { AuditingModule } from './modules/auditing/auditing.module.js';
import { ConnectionsModule } from './modules/connections/connections.module.js';
import { HealthController } from './health/health.controller.js';
import { CurrentUserGuard } from './modules/identity/current-user.guard.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { MailModule } from './modules/mail/mail.module.js';
import { MembersModule } from './modules/members/members.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { TenantsModule } from './modules/tenants/tenants.module.js';
import { RedisModule } from './redis/redis.module.js';
import { APP_CONFIG, CLOCK, KEY_RING, READINESS_CHECKS } from './tokens.js';

@Module({})
class ConfigModule {
  static register(config: AppConfig, env: Record<string, string | undefined>): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: KEY_RING, useFactory: () => loadKeyRing(env) },
        { provide: CLOCK, useValue: () => new Date() },
      ],
      exports: [APP_CONFIG, KEY_RING, CLOCK],
    };
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig, env: Record<string, string | undefined> = process.env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config, env),
        // Lets tests enumerate routes (tenant matrix); no runtime cost.
        DiscoveryModule,
        DatabaseModule,
        RedisModule,
        MailModule,
        AuditingModule,
        IdentityModule,
        TenantsModule,
        ProductsModule,
        MembersModule,
        ConnectionsModule.register(env),
        AgentsModule,
      ],
      controllers: [HealthController],
      providers: [
        {
          provide: READINESS_CHECKS,
          useValue: [postgresCheck(config.databaseUrl), redisCheck(config.redisUrl)],
        },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        // Guards run in this order.
        { provide: APP_GUARD, useClass: OriginGuard },
        { provide: APP_GUARD, useExisting: AgentAuthGuard },
        { provide: APP_GUARD, useExisting: CurrentUserGuard },
        { provide: APP_GUARD, useClass: TenantGuard },
      ],
    };
  }
}
