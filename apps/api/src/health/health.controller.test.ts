import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadinessCheck } from '@pcp/health';
import { APP_CONFIG, READINESS_CHECKS } from '../tokens.js';
import { HealthController } from './health.controller.js';

let app: NestFastifyApplication | undefined;

async function start(checks: ReadinessCheck[]) {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: READINESS_CHECKS, useValue: checks },
      { provide: APP_CONFIG, useValue: { deploymentMode: 'self_hosted', port: 0 } },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const failingPostgres: ReadinessCheck = {
  name: 'postgres',
  check: async () => {
    throw new Error('connection refused');
  },
};

describe('HealthController', () => {
  it('GET /healthz returns ok with deployment mode', async () => {
    const res = await (await start([])).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'api', deploymentMode: 'self_hosted' });
  });

  it('GET /readyz returns 200 when checks pass', async () => {
    const res = await (await start([{ name: 'redis', check: async () => {} }])).inject({
      method: 'GET',
      url: '/readyz',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: [{ name: 'redis', ok: true }] });
  });

  it('GET /readyz returns 503 naming the failing check while /healthz stays 200', async () => {
    const started = await start([failingPostgres]);
    const ready = await started.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: 'not_ready',
      checks: [{ name: 'postgres', ok: false, error: 'connection refused' }],
    });
    const health = await started.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });
});
