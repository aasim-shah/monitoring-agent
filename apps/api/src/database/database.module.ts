import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import type { AppConfig } from '../config.js';
import { APP_CONFIG, PRISMA } from '../tokens.js';

@Injectable()
class PrismaShutdown implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}
  async onApplicationShutdown() {
    await this.prisma.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => createPrismaClient(c.databaseUrl),
    },
    PrismaShutdown,
  ],
  exports: [PRISMA],
})
export class DatabaseModule {}
