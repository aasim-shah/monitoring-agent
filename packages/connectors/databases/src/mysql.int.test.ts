import { defineTemplate } from '@pcp/connector-sdk';
import mysql from 'mysql2/promise';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMysqlConnector, mysqlConnector } from './mysql.js';
import { testContext } from './test-context.js';

let db: StartedTestContainer;
let config: Record<string, unknown>;

beforeAll(async () => {
  db = await new GenericContainer('mysql:8.0')
    .withEnvironment({ MYSQL_ROOT_PASSWORD: 'root', MYSQL_DATABASE: 'app' })
    .withExposedPorts(3306)
    .withWaitStrategy(Wait.forLogMessage(/ready for connections.*port: 3306/))
    .withStartupTimeout(180_000)
    .start();
  const admin = await mysql.createConnection({
    host: db.getHost(),
    port: db.getMappedPort(3306),
    user: 'root',
    password: 'root',
    database: 'app',
    multipleStatements: true,
  });
  await admin.query(`
    CREATE TABLE signups (id INT AUTO_INCREMENT PRIMARY KEY, created_at DATETIME NOT NULL);
    SET SESSION cte_max_recursion_depth = 10000;
    INSERT INTO signups (created_at)
      WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 5000)
      SELECT NOW() - INTERVAL (n % 5) DAY FROM g;
    CREATE USER 'ro'@'%' IDENTIFIED BY 'ro-pass';
    GRANT SELECT, PROCESS, REPLICATION CLIENT ON *.* TO 'ro'@'%';
    CREATE USER 'rw'@'%' IDENTIFIED BY 'rw-pass';
    GRANT SELECT, INSERT ON app.* TO 'rw'@'%';`);
  await admin.end();
  config = {
    host: db.getHost(),
    port: db.getMappedPort(3306),
    database: 'app',
    tls: true,
    tlsVerify: false, // the image's self-signed certificate
    templateParams: { table: 'signups', column: 'created_at' },
  };
});

afterAll(async () => {
  await db?.stop();
});

const ro = { username: 'ro', password: 'ro-pass' };
const rw = { username: 'rw', password: 'rw-pass' };

describe('MySQL connector (WB-07)', () => {
  it('validates a read-only user over TLS', async () => {
    await expect(mysqlConnector.validate(testContext(config, ro))).resolves.toMatchObject({ ok: true });
  });

  it('refuses a user that can write unless acknowledged', async () => {
    await expect(mysqlConnector.validate(testContext(config, rw))).rejects.toMatchObject({
      reason: 'permission_denied',
    });
    await expect(
      mysqlConnector.validate(testContext({ ...config, writeOverrideAcknowledged: true }, rw)),
    ).resolves.toMatchObject({ ok: true });
  });

  it('reports health: threads vs max connections, schema sizes, slow queries', async () => {
    const h = await mysqlConnector.health!(testContext(config, ro));
    expect(h.data).toMatchObject({
      connections: expect.any(Number),
      maxConnections: expect.any(Number),
      slowQueries: expect.any(Number),
      replicationLagSeconds: null,
    });
    expect((h.data!.schemas as Array<{ name: string }>).map((s) => s.name)).toContain('app');
    // Per-table estimates for the daily report (M15b); InnoDB counts are approximate.
    expect(h.data!.tables).toEqual([{ name: 'app.signups', rows: expect.any(Number) }]);
    expect(h.data!.tablesApproximate).toBe(true);
  });

  it('runs templates and caps rows at 1,000', async () => {
    const res = await mysqlConnector.runTemplate!(testContext(config, ro), 'rows_created_per_day', {
      from: new Date(Date.now() - 10 * 86400_000).toISOString(),
      to: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(res.rows.reduce((n, r) => n + Number(r.count), 0)).toBe(5000);
    const all = defineTemplate({
      name: 'all_ids',
      description: 't',
      engine: 'mysql',
      query: 'SELECT id FROM {{table}}',
    });
    const capped = await createMysqlConnector([all]).runTemplate!(testContext(config, ro), 'all_ids', {
      from: '',
      to: '',
    });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.rows).toHaveLength(1000);
  });

  it('distinguishes authentication and network failures', async () => {
    await expect(
      mysqlConnector.validate(testContext(config, { username: 'ro', password: 'no' })),
    ).rejects.toMatchObject({
      reason: 'authentication_failed',
    });
    await expect(mysqlConnector.validate(testContext({ ...config, port: 1 }, ro))).rejects.toMatchObject({
      reason: 'network_unreachable',
    });
  });
});
