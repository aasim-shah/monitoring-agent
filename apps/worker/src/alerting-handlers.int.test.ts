import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import { createQueues, type Queues } from '@pcp/jobs';
import type { TenantContext } from '@pcp/shared-contracts';
import { startPostgres, startRedis, type TestDatabase, type TestRedis } from '@pcp/test-support';
import { alertingHandlers } from './alerting-handlers.js';

let db: TestDatabase;
let redis: TestRedis;
let prisma: PrismaClient;
let queues: Queues;
const mails: Array<{ to: string[]; subject: string }> = [];

async function sql(text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.superuserUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

const ctx = (organizationId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'test' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: 'r',
});

beforeAll(async () => {
  [db, redis] = await Promise.all([startPostgres(), startRedis()]);
  prisma = createPrismaClient(db.appUrl);
  queues = createQueues(redis.url);
});

afterAll(async () => {
  await queues?.close();
  await prisma?.$disconnect();
  await Promise.all([db?.stop(), redis?.stop()]);
});

describe('worker alerting handlers (UC-13-03/05)', () => {
  it('turns a silent agent into an incident, queues the email, and sends it', async () => {
    const [org, product, env, enrollment, agent] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'Acme')`, [org]);
    await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'Shop')`, [product, org]);
    await sql(
      `INSERT INTO environments (id, organization_id, product_id, name) VALUES ($1, $2, $3, 'production')`,
      [env, org, product],
    );
    await sql(
      `INSERT INTO agent_enrollments (id, organization_id, product_id, environment_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
      [enrollment, org, product, env, `enr-${enrollment}`],
    );
    await sql(
      `INSERT INTO agents (id, organization_id, product_id, environment_id, enrollment_id, agent_type, hostname, machine_id, os, arch, agent_version, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, 'host', 'vps-1', 'm1', 'linux', 'amd64', '0.2.0', now() - interval '20 minutes')`,
      [agent, org, product, env, enrollment],
    );
    await sql(
      `INSERT INTO alert_rules (id, organization_id, product_id, name, template, params, severity, updated_at)
       VALUES ($1, $2, $3, 'Agent heartbeat missing', 'agent_heartbeat_missing', '{"minutes":5}', 'critical', now())`,
      [randomUUID(), org, product],
    );
    await sql(
      `INSERT INTO notification_channels (id, organization_id, name, kind, config, updated_at)
       VALUES ($1, $2, 'Ops', 'email', '{"recipients":["ops@example.com"]}', now())`,
      [randomUUID(), org],
    );
    const handlers = alertingHandlers({
      prisma,
      queues,
      keyRing: new Map(),
      appOrigin: 'https://monitor.example.com',
      now: () => new Date(),
      sendMail: async (m) => {
        mails.push(m);
      },
    });
    const tick = await handlers['alert-tick'](ctx(org), org, { attemptsMade: 0, opts: { attempts: 5 } });
    expect(tick).toEqual({ deliveries: 1 });
    const [delivery] = await sql(
      `SELECT id, status FROM notification_deliveries WHERE organization_id = $1`,
      [org],
    );
    expect(delivery.status).toBe('pending');
    const queued = await queues.get('notification-deliver').getJobs(['waiting', 'delayed']);
    expect(queued.map((j) => j.data.connectionId)).toContain(delivery.id);

    await handlers['notification-deliver'](ctx(org), delivery.id, { attemptsMade: 0, opts: { attempts: 5 } });
    expect(mails).toEqual([
      expect.objectContaining({
        to: ['ops@example.com'],
        subject: '[CRITICAL] Agent heartbeat missing on vps-1 — opened',
      }),
    ]);
  });
});
