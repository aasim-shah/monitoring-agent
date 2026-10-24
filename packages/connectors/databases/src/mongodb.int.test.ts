import { defineTemplate } from '@pcp/connector-sdk';
import { MongoClient } from 'mongodb';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMongodbConnector, mongodbConnector } from './mongodb.js';
import { testContext } from './test-context.js';

let db: StartedTestContainer;
let config: Record<string, unknown>;

beforeAll(async () => {
  db = await new GenericContainer('mongo:8.0')
    .withEnvironment({ MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'root' })
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/, 2))
    .withStartupTimeout(180_000)
    .start();
  const admin = new MongoClient(
    `mongodb://root:root@${db.getHost()}:${db.getMappedPort(27017)}/?authSource=admin`,
  );
  await admin.connect();
  const app = admin.db('firemaps');
  const now = Date.now();
  await app.collection('incidents').insertMany(
    Array.from({ length: 5000 }, (_, i) => ({
      createdAt: new Date(now - (i % 5) * 86400_000),
      severity: i % 3,
    })),
  );
  await app.collection('stations').insertMany([{ name: 'A' }, { name: 'B' }]);
  await admin.db('admin').command({
    createUser: 'ro',
    pwd: 'ro-pass',
    roles: [
      { role: 'read', db: 'firemaps' },
      { role: 'clusterMonitor', db: 'admin' },
    ],
  });
  await admin
    .db('admin')
    .command({ createUser: 'rw', pwd: 'rw-pass', roles: [{ role: 'readWrite', db: 'firemaps' }] });
  await admin.close();
  config = {
    host: db.getHost(),
    port: db.getMappedPort(27017),
    database: 'firemaps',
    tls: false,
    allowInsecure: true,
    templateParams: { collection: 'incidents', field: 'createdAt' },
  };
});

afterAll(async () => {
  await db?.stop();
});

const ro = { username: 'ro', password: 'ro-pass' };
const rw = { username: 'rw', password: 'rw-pass' };

describe('MongoDB connector (WB-07, FireMaps-like fixture)', () => {
  it('validates a read-only user', async () => {
    await expect(mongodbConnector.validate(testContext(config, ro))).resolves.toMatchObject({ ok: true });
  });

  it('refuses a readWrite user unless acknowledged', async () => {
    await expect(mongodbConnector.validate(testContext(config, rw))).rejects.toMatchObject({
      reason: 'permission_denied',
    });
    await expect(
      mongodbConnector.validate(testContext({ ...config, writeOverrideAcknowledged: true }, rw)),
    ).resolves.toMatchObject({ ok: true });
  });

  it('reports serverStatus connections, replica state, and dbStats sizes', async () => {
    const h = await mongodbConnector.health!(testContext(config, ro));
    expect(h.data).toMatchObject({
      connections: expect.any(Number),
      availableConnections: expect.any(Number),
      replicaSet: null,
      database: { name: 'firemaps', collections: 2, objects: 5002 },
    });
    expect((h.data!.database as { dataSizeBytes: number }).dataSizeBytes).toBeGreaterThan(0);
    // Per-collection counts for the daily report (M15b), largest first.
    expect(h.data!.collections).toEqual([
      { name: 'incidents', documents: 5000 },
      { name: 'stations', documents: 2 },
    ]);
  });

  it('runs the documents-per-day template and caps at 1,000 rows', async () => {
    const res = await mongodbConnector.runTemplate!(testContext(config, ro), 'documents_per_day', {
      from: new Date(Date.now() - 10 * 86400_000).toISOString(),
      to: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(res.rows.reduce((n, r) => n + Number(r.count), 0)).toBe(5000);
    const all = defineTemplate({
      name: 'all_docs',
      description: 't',
      engine: 'mongodb',
      pipeline: [{ $project: { _id: 1 } }],
    });
    const capped = await createMongodbConnector([all]).runTemplate!(testContext(config, ro), 'all_docs', {
      from: '',
      to: '',
    });
    expect(capped.rows).toHaveLength(1000);
    expect(capped.truncated).toBe(true);
  });

  it('distinguishes authentication and network failures', async () => {
    await expect(
      mongodbConnector.validate(testContext(config, { username: 'ro', password: 'x' })),
    ).rejects.toMatchObject({
      reason: 'authentication_failed',
    });
    await expect(mongodbConnector.validate(testContext({ ...config, port: 1 }, ro))).rejects.toMatchObject({
      reason: 'network_unreachable',
    });
  });
});
