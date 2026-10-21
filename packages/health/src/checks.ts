import { Redis } from 'ioredis';
import pg from 'pg';
import type { ReadinessCheck } from './run-checks.js';

export function postgresCheck(url: string): ReadinessCheck {
  return {
    name: 'postgres',
    async check() {
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
      try {
        await client.connect();
        await client.query('SELECT 1');
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

export function redisCheck(url: string): ReadinessCheck {
  return {
    name: 'redis',
    async check() {
      const client = new Redis(url, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 0 });
      try {
        await client.connect();
        await client.ping();
      } finally {
        client.disconnect();
      }
    },
  };
}
