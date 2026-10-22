import { defineTemplate, type ConnectorError } from '@pcp/connector-sdk';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresConnector, postgresConnector } from './postgres.js';
import { testContext } from './test-context.js';

let db: StartedTestContainer;
let config: Record<string, unknown>;

beforeAll(async () => {
  db = await new GenericContainer('postgres:17.6-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'root', POSTGRES_DB: 'app' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const admin = new pg.Client({
    host: db.getHost(),
    port: db.getMappedPort(5432),
    user: 'postgres',
    password: 'root',
    database: 'app',
  });
  await admin.connect();
  await admin.query(`
    CREATE TABLE signups (id serial PRIMARY KEY, created_at timestamptz NOT NULL);
    INSERT INTO signups (created_at) SELECT now() - (g % 5) * interval '1 day' FROM generate_series(1, 5000) g;
    CREATE ROLE ro LOGIN PASSWORD 'ro-pass';
    GRANT CONNECT ON DATABASE app TO ro; GRANT USAGE ON SCHEMA public TO ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro; GRANT pg_monitor TO ro;
    CREATE ROLE rw LOGIN PASSWORD 'rw-pass';
    GRANT CONNECT ON DATABASE app TO rw; GRANT USAGE ON SCHEMA public TO rw;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO rw;`);
  await admin.end();
  config = {
    host: db.getHost(),
    port: db.getMappedPort(5432),
    database: 'app',
    tls: false,
    allowInsecure: true,
    templateParams: { table: 'signups', column: 'created_at' },
  };
});

afterAll(async () => {
  await db?.stop();
});

const ro = { username: 'ro', password: 'ro-pass' };
const rw = { username: 'rw', password: 'rw-pass' };

describe('PostgreSQL connector (WB-07)', () => {
  it('validates a read-only user (UC-07-03)', async () => {
    await expect(postgresConnector.validate(testContext(config, ro))).resolves.toMatchObject({ ok: true });
  });

  it('refuses a user that can write unless an admin acknowledged it (TC-07-03, UC-07-06)', async () => {
    await expect(postgresConnector.validate(testContext(config, rw))).rejects.toMatchObject({
      reason: 'permission_denied',
    } satisfies Partial<ConnectorError>);
    await expect(
      postgresConnector.validate(testContext({ ...config, writeOverrideAcknowledged: true }, rw)),
    ).resolves.toMatchObject({ ok: true });
  });

  it('reports health: connections, sizes, replication, slow queries (TC-07-06)', async () => {
    const h = await postgresConnector.health!(testContext(config, ro));
    expect(h.ok).toBe(true);
    expect(h.data).toMatchObject({
      connections: expect.any(Number),
      maxConnections: 100,
      replicationLagSeconds: null,
      slowQueries: 'extension not installed',
    });
    expect(
      (h.data!.databases as Array<{ name: string; bytes: number }>).find((d) => d.name === 'app')!.bytes,
    ).toBeGreaterThan(0);
  });

  it('runs a named template over a time window', async () => {
    const res = await postgresConnector.runTemplate!(testContext(config, ro), 'rows_created_per_day', {
      from: new Date(Date.now() - 10 * 86400_000).toISOString(),
      to: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(res.truncated).toBe(false);
    expect(res.rows.reduce((n, r) => n + Number(r.count), 0)).toBe(5000);
    await expect(
      postgresConnector.runTemplate!(testContext(config, ro), 'drop_everything', { from: '', to: '' }),
    ).rejects.toMatchObject({ reason: 'invalid_config' });
  });

  it('caps template results at 1,000 rows (TC-07-05)', async () => {
    const all = defineTemplate({
      name: 'all_ids',
      description: 'test',
      engine: 'postgres',
      query: 'SELECT id FROM {{table}}',
    });
    const res = await createPostgresConnector([all]).runTemplate!(testContext(config, ro), 'all_ids', {
      from: '',
      to: '',
    });
    expect(res.rows).toHaveLength(1000);
    expect(res.truncated).toBe(true);
  });

  it('runs every session read-only even if a template slipped through', async () => {
    const insert = {
      name: 'insert',
      description: '',
      engine: 'postgres',
      query: 'INSERT INTO signups (created_at) VALUES (now()) RETURNING id',
    } as never;
    await expect(
      createPostgresConnector([insert]).runTemplate!(
        testContext({ ...config, writeOverrideAcknowledged: true }, rw),
        'insert',
        { from: '', to: '' },
      ),
    ).rejects.toThrow(/read-only/);
  });

  it('distinguishes authentication, network, and TLS failures', async () => {
    await expect(
      postgresConnector.validate(testContext(config, { username: 'ro', password: 'wrong' })),
    ).rejects.toMatchObject({
      reason: 'authentication_failed',
    });
    await expect(postgresConnector.validate(testContext({ ...config, port: 1 }, ro))).rejects.toMatchObject({
      reason: 'network_unreachable',
    });
    await expect(
      postgresConnector.validate(testContext({ ...config, tls: true, allowInsecure: false }, ro)),
    ).rejects.toMatchObject({
      reason: 'tls_unavailable',
    });
    await expect(
      postgresConnector.validate(testContext({ ...config, tls: false, allowInsecure: false }, ro)),
    ).rejects.toMatchObject({
      reason: 'invalid_config',
    });
  });
});
