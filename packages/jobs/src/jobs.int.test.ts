import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorRuntime, storeCredentials } from '@pcp/connector-runtime';
import { ConnectorRegistry } from '@pcp/connector-sdk';
import { mockConnector } from '@pcp/connectors-mock';
import { createPrismaClient, withCredentials, type PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import {
  startPostgres,
  startRedis,
  TEST_PASSWORDS,
  type TestDatabase,
  type TestRedis,
} from '@pcp/test-support';
import {
  createQueues,
  enqueue,
  reconcileSchedules,
  startProcessors,
  type Processors,
  type Queues,
} from './index.js';

let db: TestDatabase;
let redis: TestRedis;
let prisma: PrismaClient;
let scheduler: PrismaClient;
let queues: Queues;
let processors: Processors;
const org = randomUUID();
const product = randomUUID();
const reauthNotices: string[] = [];
const key = randomBytes(32);
const keyRing = { active: { version: 1, key }, ring: new Map([[1, key]]) };
const ctx: TenantContext = {
  organizationId: org,
  actor: { kind: 'system', jobId: 'test' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: 'req',
};

async function sql(text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.superuserUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

async function connection(behavior: string): Promise<string> {
  const id = randomUUID();
  await withTenant(prisma, ctx, async (tx) => {
    await tx.connection.create({
      data: {
        id,
        organizationId: org,
        provider: 'mock',
        displayName: 'M',
        executionLocation: 'cloud',
        status: 'pending_validation',
        config: { behavior },
      },
    });
    await storeCredentials(tx, ctx, id, { token: 'mock-token-value' }, keyRing);
  });
  return id;
}

async function eventually<T>(fn: () => Promise<T>, check: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (check(v)) return v;
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  [db, redis] = await Promise.all([startPostgres(), startRedis()]);
  prisma = createPrismaClient(db.appUrl);
  scheduler = createPrismaClient(withCredentials(db.superuserUrl, 'pcp_scheduler', TEST_PASSWORDS.scheduler));
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'Org')`, [org]);
  await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P')`, [product, org]);
  const registry = new ConnectorRegistry();
  registry.register(mockConnector);
  queues = createQueues(redis.url, { backoffMs: 20 });
  processors = startProcessors({
    redisUrl: redis.url,
    prisma,
    runtime: new ConnectorRuntime(prisma, registry, keyRing),
    onReauthorizationRequired: async (_ctx, connectionId) => {
      reauthNotices.push(connectionId);
    },
  });
}, 180_000);

afterAll(async () => {
  await processors?.close();
  await queues?.close();
  await Promise.all([prisma?.$disconnect(), scheduler?.$disconnect()]);
  await Promise.all([db?.stop(), redis?.stop()]);
});

const runs = (connectionId: string) =>
  sql(`SELECT kind, status, items FROM sync_runs WHERE connection_id = $1`, [connectionId]);

/** A connected mock connection with one resource scoped to the product, ready to sync. */
async function syncable(behavior: string): Promise<string> {
  const id = await connection(behavior);
  await sql(`UPDATE connections SET status = 'connected' WHERE id = $1`, [id]);
  await sql(
    `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id)
     VALUES ($1, $2, 'mock-1', 'mock_resource', 'R', $3)`,
    [org, id, product],
  );
  return id;
}

const values = (connectionId: string) =>
  sql(`SELECT metric, value, completeness FROM metric_aggregates WHERE connection_id = $1`, [connectionId]);

describe('job processors', () => {
  it('stores synced KPI values: 28 days back on the first run, then 3, replacing the day (M13b)', async () => {
    const id = await syncable('ok');
    const sync = (requestId: string) =>
      enqueue(queues, 'connection-sync', { organizationId: org, connectionId: id, requestId });
    await sync('s1');
    await eventually(
      () => values(id),
      (r) => r.length === 1,
    );
    expect(await values(id)).toEqual([{ metric: 'mock_days', value: 28, completeness: 'complete' }]);
    await eventually(
      () => runs(id),
      (r) => r[0]?.status === 'succeeded',
    );
    await sync('s2');
    await eventually(
      () => values(id),
      (r) => r[0]?.value === 3,
    );
    expect(await values(id)).toHaveLength(1);
    expect((await runs(id)).map((r) => [r.kind, r.status, r.items])).toEqual([
      ['sync', 'succeeded', 1],
      ['sync', 'succeeded', 1],
    ]);
  });

  it('a revoked grant stops sync, writes no value, and tells the owner once (Review Focus #2)', async () => {
    const id = await syncable('unauthorized');
    for (const requestId of ['u1', 'u2']) {
      await enqueue(queues, 'connection-sync', { organizationId: org, connectionId: id, requestId });
      await eventually(
        () => runs(id),
        (r) => r.filter((x) => x.status === 'failed').length === (requestId === 'u1' ? 1 : 2),
      );
    }
    expect(await values(id)).toEqual([]);
    expect(reauthNotices.filter((c) => c === id)).toHaveLength(1);
    const [c] = await sql(`SELECT status, status_reason FROM connections WHERE id = $1`, [id]);
    expect(c).toEqual({ status: 'degraded', status_reason: 'reauthorization_required' });
  });

  it('validates a connection and records the run', async () => {
    const id = await connection('ok');
    await enqueue(queues, 'connection-validate', { organizationId: org, connectionId: id, requestId: 'r1' });
    const done = await eventually(
      () => runs(id),
      (r) => r[0]?.status === 'succeeded',
    );
    expect(done).toEqual([{ kind: 'validate', status: 'succeeded', items: null }]);
    const [c] = await sql(`SELECT status FROM connections WHERE id = $1`, [id]);
    expect(c.status).toBe('connected');
  });

  it('runs scheduled health checks for managed connections and records them', async () => {
    const id = await connection('ok');
    await enqueue(queues, 'connection-validate', { organizationId: org, connectionId: id, requestId: 'h0' });
    await eventually(
      () => runs(id),
      (r) => r[0]?.status === 'succeeded',
    );
    await enqueue(queues, 'connection-health', { organizationId: org, connectionId: id, requestId: 'h1' });
    const health = await eventually(
      () => sql(`SELECT ok FROM connection_health WHERE connection_id = $1 ORDER BY checked_at`, [id]),
      (r) => r.length === 2,
    );
    expect(health.map((r) => r.ok)).toEqual([true, true]);
  });

  it('runs a job enqueued twice only once (Review Focus #3)', async () => {
    const id = await connection('ok');
    const payload = { organizationId: org, connectionId: id, requestId: 'r2' };
    await Promise.all([
      enqueue(queues, 'connection-discover', payload),
      enqueue(queues, 'connection-discover', payload),
    ]);
    await eventually(
      () => runs(id),
      (r) => r.some((x) => x.status === 'succeeded'),
    );
    await new Promise((r) => setTimeout(r, 1000));
    expect(await runs(id)).toEqual([{ kind: 'discover', status: 'succeeded', items: 2 }]);
  });

  it('stores what discovery found, replacing the previous inventory (M7)', async () => {
    const id = await connection('ok');
    const inventory = () =>
      sql(
        `SELECT resource_type, external_id, name FROM connection_inventory WHERE connection_id = $1 ORDER BY external_id`,
        [id],
      );
    await enqueue(queues, 'connection-discover', {
      organizationId: org,
      connectionId: id,
      requestId: 'inv-1',
    });
    await eventually(inventory, (r) => r.length === 2);
    expect(await inventory()).toEqual([
      { resource_type: 'mock_resource', external_id: 'mock-1', name: 'Mock resource 1' },
      { resource_type: 'mock_resource', external_id: 'mock-2', name: 'Mock resource 2' },
    ]);
    await sql(`UPDATE connections SET config = '{"behavior":"ok","resources":1}' WHERE id = $1`, [id]);
    await enqueue(queues, 'connection-discover', {
      organizationId: org,
      connectionId: id,
      requestId: 'inv-2',
    });
    await eventually(inventory, (r) => r.length === 1);
  });

  it('dead-letters a job after 5 failed attempts', async () => {
    const id = await connection('unavailable');
    const job = await enqueue(queues, 'connection-discover', {
      organizationId: org,
      connectionId: id,
      requestId: 'r3',
    });
    const [exec] = await eventually(
      () => sql(`SELECT status, attempts, error FROM job_executions WHERE job_id = $1`, [job]),
      (r) => r.length > 0,
    );
    expect(exec).toMatchObject({ status: 'dead_letter', attempts: 5 });
    expect(exec.error).not.toContain('mock-token-value');
  });
});

describe('schedule reconciliation (Review Focus #4)', () => {
  it('mirrors enabled job definitions and survives a restart', async () => {
    const c1 = await connection('ok');
    const c2 = await connection('ok');
    const d1 = randomUUID();
    const d2 = randomUUID();
    await sql(
      `INSERT INTO job_definitions (id, organization_id, kind, entity_id, every_seconds) VALUES
       ($1, $3, 'connection-validate', $4, 900), ($2, $3, 'connection-discover', $5, 21600)`,
      [d1, d2, org, c1, c2],
    );
    // Other tests' connections may own schedules too (e.g. health); look at this test's only.
    const mine = async (q: typeof queues) =>
      (await q.schedulerIds()).filter((i) => [`schedule-${d1}`, `schedule-${d2}`].includes(i)).sort();
    await reconcileSchedules(scheduler, queues);
    expect(await mine(queues)).toEqual([`schedule-${d1}`, `schedule-${d2}`].sort());

    // A fresh process (new queue connections) reconciles to the same set.
    const fresh = createQueues(redis.url);
    await reconcileSchedules(scheduler, fresh);
    expect(await mine(fresh)).toEqual([`schedule-${d1}`, `schedule-${d2}`].sort());

    await sql(`UPDATE job_definitions SET enabled = false WHERE id = $1`, [d2]);
    await reconcileSchedules(scheduler, fresh);
    expect(await mine(fresh)).toEqual([`schedule-${d1}`]);
    await fresh.close();
  });
});
