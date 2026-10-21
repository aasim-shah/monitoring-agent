import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { APP_CONFIG, REDIS } from '../tokens.js';

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  onApplicationShutdown() {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => new Redis(c.redisUrl, { maxRetriesPerRequest: 2 }),
    },
    RedisShutdown,
  ],
  exports: [REDIS],
})
export class RedisModule {}
