// Starts one PostgreSQL, one Redis, and one VictoriaMetrics container for the whole API test run.
import type { TestProject } from 'vitest/node';
import { startPostgres, startRedis, startVictoria } from '@pcp/test-support';

declare module 'vitest' {
  export interface ProvidedContext {
    appDbUrl: string;
    superuserDbUrl: string;
    redisUrl: string;
    vmUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const [db, redis, vm] = await Promise.all([startPostgres(), startRedis(), startVictoria()]);
  project.provide('appDbUrl', db.appUrl);
  project.provide('superuserDbUrl', db.superuserUrl);
  project.provide('redisUrl', redis.url);
  project.provide('vmUrl', vm.url);
  return async () => {
    await Promise.all([db.stop(), redis.stop(), vm.stop()]);
  };
}
