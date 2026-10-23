import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mongodbConnector } from './mongodb.js';
import { mysqlConnector } from './mysql.js';
import { postgresConnector } from './postgres.js';
import { testContext } from './test-context.js';
import { parseConnectionString } from './common.js';

let pgDb: StartedTestContainer;

beforeAll(async () => {
  pgDb = await new GenericContainer('postgres:17.6-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'root', POSTGRES_DB: 'app' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
});

afterAll(async () => {
  await pgDb?.stop();
});

describe('connection strings (managed databases)', () => {
  it('parses PostgreSQL, MySQL, and MongoDB URIs without keeping the password in config', () => {
    expect(
      parseConnectionString('postgresql://postgres.abcd:pa%40ss@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require'),
    ).toEqual({
      engine: 'postgres',
      host: 'aws-0-eu-central-1.pooler.supabase.com',
      port: 6543,
      database: 'postgres',
      username: 'postgres.abcd',
      password: 'pa@ss',
      srv: false,
    });
    expect(parseConnectionString('mongodb+srv://monitor:x@cluster0.ab12c.mongodb.net/firemaps?retryWrites=true')).toMatchObject({
      engine: 'mongodb',
      host: 'cluster0.ab12c.mongodb.net',
      database: 'firemaps',
      srv: true,
    });
    expect(parseConnectionString('mysql://ro:pw@db.example.com/shop')).toMatchObject({ engine: 'mysql', port: 3306 });
    expect(() => parseConnectionString('redis://x')).toThrow(/postgres/);
  });

  it('connects with a connection-string credential', async () => {
    const uri = `postgresql://postgres:root@${pgDb.getHost()}:${pgDb.getMappedPort(5432)}/app?sslmode=require`;
    const ctx = testContext(
      { host: pgDb.getHost(), port: pgDb.getMappedPort(5432), database: 'app', tls: false, allowInsecure: true, writeOverrideAcknowledged: true },
      { connectionString: uri },
    );
    // sslmode in the string does not override the configured TLS mode.
    await expect(postgresConnector.validate(ctx)).resolves.toMatchObject({ ok: true });
  });
});

describe('cloud execution (BR-07-06 for managed databases)', () => {
  const cloud = (config: Record<string, unknown>, creds: Record<string, string>) => ({
    ...testContext(config, creds),
    executionLocation: 'cloud' as const,
  });

  it('refuses private and loopback hosts before connecting', async () => {
    for (const host of ['127.0.0.1', '10.0.0.5', 'localhost', '169.254.169.254']) {
      await expect(
        postgresConnector.validate(cloud({ host, port: 5432, database: 'app' }, { username: 'u', password: 'p' })),
      ).rejects.toMatchObject({ reason: 'destination_blocked' });
    }
    await expect(
      mysqlConnector.validate(cloud({ host: '192.168.1.10' }, { connectionString: 'mysql://u:p@192.168.1.10/shop' })),
    ).rejects.toMatchObject({ reason: 'destination_blocked' });
    await expect(
      mongodbConnector.validate(cloud({ host: '127.0.0.1', database: 'x' }, { connectionString: 'mongodb://u:p@127.0.0.1:27017/x' })),
    ).rejects.toMatchObject({ reason: 'destination_blocked' });
  });

  it('requires TLS over the internet, even with allowInsecure', async () => {
    await expect(
      postgresConnector.validate(cloud({ host: 'db.example.com', tls: false, allowInsecure: true }, { username: 'u', password: 'p' })),
    ).rejects.toMatchObject({ reason: 'invalid_config' });
  });

  it('is allowed for all three engines', () => {
    for (const c of [postgresConnector, mysqlConnector, mongodbConnector]) expect(c.executionLocations).toContain('cloud');
  });
});
