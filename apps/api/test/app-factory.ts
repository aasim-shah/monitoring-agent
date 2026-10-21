import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { inject } from 'vitest';
import type { PrismaClient } from '@pcp/database';
import { AppModule } from '../src/app.module.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { MAILER } from '../src/modules/mail/mailer.js';
import { GOOGLE_HTTP, type GoogleHttp } from '../src/modules/identity/google-login.service.js';
import { PRISMA } from '../src/tokens.js';
import { MemoryMailer } from './memory-mailer.js';

export const MASTER_KEY = randomBytes(32).toString('base64');
export const APP_ORIGIN = 'http://localhost:8080';

export interface TestApp {
  app: NestFastifyApplication;
  mailer: MemoryMailer;
  prisma: PrismaClient;
  config: AppConfig;
  close(): Promise<void>;
}

export async function createTestApp(
  opts: { env?: Record<string, string>; google?: GoogleHttp } = {},
): Promise<TestApp> {
  const env = {
    DATABASE_URL: inject('appDbUrl'),
    REDIS_URL: inject('redisUrl'),
    MASTER_KEY,
    APP_ORIGIN,
    BOOTSTRAP_MODE: 'off',
    ...opts.env,
  };
  const config = loadConfig(env);
  const mailer = new MemoryMailer();
  let builder = Test.createTestingModule({ imports: [AppModule.register(config, env)] })
    .overrideProvider(MAILER)
    .useValue(mailer);
  if (opts.google) builder = builder.overrideProvider(GOOGLE_HTTP).useValue(opts.google);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ trustProxy: true }),
  );
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, mailer, prisma: app.get(PRISMA), config, close: () => app.close() };
}

/** Unique email and an IP so rate limits never collide between tests. */
export function uniqueEmail(): string {
  return `user-${randomUUID()}@example.com`;
}

let ipCounter = 0;
export function uniqueIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const header = res.headers['set-cookie'];
  const all = Array.isArray(header) ? header : [String(header ?? '')];
  const cookie = all.find((c) => c.startsWith('pcp_session='));
  if (!cookie) throw new Error('no pcp_session cookie');
  return cookie.split(';')[0]!;
}
