// Starts one PostgreSQL and one Redis container for the whole API test run.
import type { TestProject } from 'vitest/node';
import { startPostgres, startRedis } from '@pcp/test-support';

declare module 'vitest' {
  export interface ProvidedContext {
    appDbUrl: string;
    superuserDbUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const [db, redis] = await Promise.all([startPostgres(), startRedis()]);
  project.provide('appDbUrl', db.appUrl);
  project.provide('superuserDbUrl', db.superuserUrl);
  project.provide('redisUrl', redis.url);
  return async () => {
    await Promise.all([db.stop(), redis.stop()]);
  };
}
