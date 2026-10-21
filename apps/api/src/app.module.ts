import { Module, type DynamicModule } from '@nestjs/common';
import { postgresCheck, redisCheck } from '@pcp/health';
import type { AppConfig } from './config.js';
import { HealthController } from './health/health.controller.js';
import { APP_CONFIG, READINESS_CHECKS } from './tokens.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: READINESS_CHECKS, useValue: [postgresCheck(config.databaseUrl), redisCheck(config.redisUrl)] },
      ],
    };
  }
}
