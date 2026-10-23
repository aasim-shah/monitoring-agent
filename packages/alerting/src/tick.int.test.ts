import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import { startPostgres, type TestDatabase } from '@pcp/database/testing';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { tick } from './tick.js';

let db: TestDatabase;
let prisma: PrismaClient;
const T0 = new Date('2026-10-23T10:00:00Z');
const min = (m: number) => new Date(T0.getTime() + m * 60_000);

const ctx = (organizationId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'alert-tick' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: randomUUID(),
});
const run = (org: string, at: Date) => withTenant(prisma, ctx(org), (tx) => tick(tx, org, at));

async function sql(text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.superuserUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

async function tenant() {
  const [org, product, env, enrollment] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'T')`, [org]);
  await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P')`, [product, org]);
  await sql(
    `INSERT INTO environments (id, organization_id, product_id, name) VALUES ($1, $2, $3, 'production')`,
    [env, org, product],
  );
  await sql(
    `INSERT INTO agent_enrollments (id, organization_id, product_id, environment_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
    [enrollment, org, product, env, `enr-${enrollment}`],
  );
  const agent = async (hostname: string, lastHeartbeat: Date, status = 'active') => {
    const id = randomUUID();
    await sql(
      `INSERT INTO agents (id, organization_id, product_id, environment_id, enrollment_id, agent_type, hostname, machine_id, os, arch, agent_version, status, last_heartbeat_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'host', $6, $7, 'linux', 'amd64', '0.2.0', $8, $9, $9)`,
      [id, org, product, env, enrollment, hostname, `m-${id}`, status, lastHeartbeat],
    );
    return id;
  };
  const rule = async (template: string, params: object, severity = 'critical') => {
    const id = randomUUID();
    await sql(
      `INSERT INTO alert_rules (id, organization_id, product_id, name, template, params, severity, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        id,
        org,
        product,
        (
          {
            agent_heartbeat_missing: 'Agent heartbeat missing',
            connection_degraded: 'Integration failing',
            website_down: 'Website down',
            website_tls_expiring: 'TLS certificate expiring',
          } as Record<string, string>
        )[template],
        template,
        params,
        severity,
      ],
    );
    return id;
  };
  return { org, product, agent, rule };
}

const open = (org: string) =>
  sql(`SELECT title, status, labels FROM alert_incidents WHERE organization_id = $1 ORDER BY title`, [org]);

beforeAll(async () => {
  db = await startPostgres();
  prisma = createPrismaClient(db.appUrl);
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.stop();
});

describe('alert tick: agent heartbeat missing (UC-13-03)', () => {
  it('opens an incident for a silent agent and resolves it after a new heartbeat', async () => {
    const t = await tenant();
    await t.rule('agent_heartbeat_missing', { minutes: 5 });
    const quiet = await t.agent('vps-quiet', min(-10));
    await t.agent('vps-fine', min(-1));
    const first = await run(t.org, T0);
    expect(first.map((n) => n.event)).toEqual(['opened']);
    expect(await open(t.org)).toEqual([
      {
        title: 'Agent heartbeat missing on vps-quiet',
        status: 'open',
        labels: { agent_id: quiet, hostname: 'vps-quiet' },
      },
    ]);
    await sql(`UPDATE agents SET last_heartbeat_at = $2 WHERE id = $1`, [quiet, min(1)]);
    const second = await run(t.org, min(2));
    expect(second.map((n) => n.event)).toEqual(['resolved']);
    expect((await open(t.org))[0].status).toBe('resolved');
  });

  it('never alerts for a revoked agent, and resolves an incident whose agent was revoked (Review Focus #5)', async () => {
    const t = await tenant();
    await t.rule('agent_heartbeat_missing', { minutes: 5 });
    const gone = await t.agent('vps-gone', min(-30), 'revoked');
    expect(await run(t.org, T0)).toEqual([]);
    const later = await t.agent('vps-later', min(-30));
    await run(t.org, T0);
    await sql(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [later]);
    await run(t.org, min(1));
    const rows = await open(t.org);
    expect(rows.every((r) => r.status === 'resolved')).toBe(true);
    expect(rows.some((r) => r.labels.agent_id === gone)).toBe(false);
  });
});

describe('alert tick: integration failing', () => {
  it('opens when a connection stays degraded longer than the limit', async () => {
    const t = await tenant();
    await t.rule('connection_degraded', { minutes: 15 }, 'warning');
    const conn = randomUUID();
    await sql(
      `INSERT INTO connections (id, organization_id, provider, display_name, execution_location, status, updated_at)
       VALUES ($1, $2, 'postgres', 'Orders DB', 'cloud', 'degraded', $3)`,
      [conn, t.org, min(-20)],
    );
    await sql(
      `INSERT INTO connection_resource_scopes (id, organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, $3, 'db', 'database', 'orders', $4)`,
      [randomUUID(), t.org, conn, t.product],
    );
    expect((await run(t.org, T0)).map((n) => n.event)).toEqual(['opened']);
    expect((await open(t.org))[0]).toMatchObject({
      title: 'Integration failing on Orders DB',
      status: 'open',
    });
    await sql(`UPDATE connections SET status = 'connected', updated_at = $2 WHERE id = $1`, [conn, min(1)]);
    expect((await run(t.org, min(2))).map((n) => n.event)).toEqual(['resolved']);
  });
});

describe('alert tick: escalation (TC-13-06)', () => {
  it('escalates the critical heartbeat incident after 15 minutes, once', async () => {
    const t = await tenant();
    await t.rule('agent_heartbeat_missing', { minutes: 5 });
    await t.agent('vps-down', min(-10));
    await run(t.org, T0);
    expect((await run(t.org, min(10))).map((n) => n.event)).toEqual([]);
    expect((await run(t.org, min(16))).map((n) => n.event)).toEqual(['escalated']);
    expect((await run(t.org, min(30))).map((n) => n.event)).toEqual([]);
  });
});

describe('alert tick: websites (TC-09-02, TC-09-03, Review Focus #4)', () => {
  async function monitor(org: string, product: string, over: Record<string, unknown>) {
    const id = randomUUID();
    const cols = { status: 'active', consecutive_failures: 0, tls_expires_at: null, ...over };
    await sql(
      `INSERT INTO website_monitors (id, organization_id, product_id, url, host, verify_token, verified_at, status, consecutive_failures, tls_expires_at, updated_at)
       VALUES ($1, $2, $3, 'https://shop.example.com', 'shop.example.com', 't', now(), $4, $5, $6, now())`,
      [id, org, product, cols.status, cols.consecutive_failures, cols.tls_expires_at],
    );
    return id;
  }

  it('opens "website down" only after 2 failed probes and resolves on recovery', async () => {
    const t = await tenant();
    await t.rule('website_down', { failures: 2 });
    const id = await monitor(t.org, t.product, { consecutive_failures: 1 });
    expect(await run(t.org, T0)).toEqual([]);
    await sql(`UPDATE website_monitors SET consecutive_failures = 2 WHERE id = $1`, [id]);
    expect((await run(t.org, min(1))).map((n) => n.event)).toEqual(['opened']);
    expect((await open(t.org))[0]).toMatchObject({
      title: 'Website down on shop.example.com',
      status: 'open',
    });
    await sql(`UPDATE website_monitors SET consecutive_failures = 0 WHERE id = $1`, [id]);
    expect((await run(t.org, min(2))).map((n) => n.event)).toEqual(['resolved']);
  });

  it('warns when the certificate expires within 14 days', async () => {
    const t = await tenant();
    await t.rule('website_tls_expiring', { days: 14 }, 'warning');
    await monitor(t.org, t.product, { tls_expires_at: new Date(T0.getTime() + 13 * 86400_000) });
    expect((await run(t.org, T0)).map((n) => n.event)).toEqual(['opened']);
    expect((await open(t.org))[0]).toMatchObject({ title: 'TLS certificate expiring on shop.example.com' });
  });

  it('ignores monitors that are not verified or are paused', async () => {
    const t = await tenant();
    await t.rule('website_down', { failures: 2 });
    await monitor(t.org, t.product, { status: 'pending_verification', consecutive_failures: 5 });
    expect(await run(t.org, T0)).toEqual([]);
  });
});
