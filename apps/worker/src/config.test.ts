import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  REDIS_URL: 'redis://redis:6379',
  DATABASE_URL: 'postgres://pcp_app:x@postgres:5432/pcp',
  SCHEDULER_DATABASE_URL: 'postgres://pcp_scheduler:x@postgres:5432/pcp',
};

describe('worker config', () => {
  it('reads database, scheduler, and Redis URLs with defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      deploymentMode: 'managed',
      healthPort: 3002,
      databaseUrl: base.DATABASE_URL,
      schedulerDatabaseUrl: base.SCHEDULER_DATABASE_URL,
      reconcileEverySeconds: 60,
    });
  });
  it.each(['DATABASE_URL', 'SCHEDULER_DATABASE_URL', 'REDIS_URL'])('requires %s', (name) => {
    const { [name as keyof typeof base]: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(new RegExp(name));
  });
  it('treats empty values as unset', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});
