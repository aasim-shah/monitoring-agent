import 'reflect-metadata';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { inject } from 'vitest';
import type { PrismaClient } from '@pcp/database';
import { AppModule } from '../src/app.module.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { MAILER } from '../src/modules/mail/mailer.js';
import { GOOGLE_HTTP, type GoogleHttp } from '../src/modules/identity/google-login.service.js';
import { CLOCK, PRISMA, DNS_RESOLVER, TXT_RESOLVER } from '../src/tokens.js';
import { MemoryMailer } from './memory-mailer.js';

export const MASTER_KEY = randomBytes(32).toString('base64');
export const APP_ORIGIN = 'http://localhost:8080';

export interface TestApp {
  app: NestFastifyApplication;
  mailer: MemoryMailer;
  prisma: PrismaClient;
  config: AppConfig;
  close(): Promise<void>;
  /** The app's clock (frozen in some tests); helpers that compute TOTP codes use it. */
  now: () => Date;
}

export async function createTestApp(
  opts: {
    env?: Record<string, string>;
    google?: GoogleHttp;
    clock?: () => Date;
    /** Hostname → addresses, for discovery's dns-to-host rule. */
    dns?: (hostname: string) => Promise<string[]>;
    /** DNS TXT records by name, for website domain verification. */
    txt?: (name: string) => Promise<string[][]>;
  } = {},
): Promise<TestApp> {
  const env = {
    DATABASE_URL: inject('appDbUrl'),
    REDIS_URL: inject('redisUrl'),
    MASTER_KEY,
    APP_ORIGIN,
    BOOTSTRAP_MODE: 'off',
    NODE_ENV: 'test',
    PCP_ENABLE_MOCK_CONNECTOR: '1',
    ...opts.env,
  };
  const config = loadConfig(env);
  const mailer = new MemoryMailer();
  let builder = Test.createTestingModule({ imports: [AppModule.register(config, env)] })
    .overrideProvider(MAILER)
    .useValue(mailer);
  if (opts.google) builder = builder.overrideProvider(GOOGLE_HTTP).useValue(opts.google);
  if (opts.clock) builder = builder.overrideProvider(CLOCK).useValue(opts.clock);
  if (opts.dns) builder = builder.overrideProvider(DNS_RESOLVER).useValue(opts.dns);
  if (opts.txt) builder = builder.overrideProvider(TXT_RESOLVER).useValue(opts.txt);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ trustProxy: true }),
  );
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    mailer,
    prisma: app.get(PRISMA),
    config,
    now: opts.clock ?? (() => new Date()),
    close: () => app.close(),
  };
}

/** Unique email and an IP so rate limits never collide between tests. */
export function uniqueEmail(): string {
  return `user-${randomUUID()}@example.com`;
}

/** Random 10.x.y.z: test files run in parallel against one Redis, so per-file counters would collide. */
export function uniqueIp(): string {
  const n = randomInt(1, 2 ** 24);
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const header = res.headers['set-cookie'];
  const all = Array.isArray(header) ? header : [String(header ?? '')];
  const cookie = all.find((c) => c.startsWith('pcp_session='));
  if (!cookie) throw new Error('no pcp_session cookie');
  return cookie.split(';')[0]!;
}
