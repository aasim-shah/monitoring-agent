// Test helper: a migrated PostgreSQL in a container. Import from '@pcp/database/testing'
// in tests only (Testcontainers is a development dependency).
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrate } from './migrate.js';
import { withCredentials } from './urls.js';

export const TEST_PASSWORDS = {
  migrator: 'test-migrator',
  app: 'test-app',
  scheduler: 'test-scheduler',
} as const;

export interface TestDatabase {
  superuserUrl: string;
  migratorUrl: string;
  appUrl: string;
  shadowUrl?: string;
  /** App URL with a connection pool limit, e.g. for pooled-connection tests. */
  appUrlWithPool(limit: number): string;
  stop(): Promise<void>;
}

export async function startPostgres(opts: { shadowDatabase?: string } = {}): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17.6-alpine')
    .withDatabase('pcp')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  const superuserUrl = container.getConnectionUri();
  await migrate({ superuserUrl, passwords: TEST_PASSWORDS });

  let shadowUrl: string | undefined;
  if (opts.shadowDatabase) {
    const client = new pg.Client({ connectionString: superuserUrl });
    await client.connect();
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(opts.shadowDatabase)}`);
    await client.end();
    const u = new URL(superuserUrl);
    u.pathname = `/${opts.shadowDatabase}`;
    shadowUrl = u.toString();
  }

  const appUrl = withCredentials(superuserUrl, 'pcp_app', TEST_PASSWORDS.app);
  return {
    superuserUrl,
    migratorUrl: withCredentials(superuserUrl, 'pcp_migrator', TEST_PASSWORDS.migrator),
    appUrl,
    shadowUrl,
    appUrlWithPool(limit: number) {
      const u = new URL(appUrl);
      u.searchParams.set('connection_limit', String(limit));
      return u.toString();
    },
    async stop() {
      await container.stop();
    },
  };
}
