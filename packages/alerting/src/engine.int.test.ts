import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import { startPostgres, type TestDatabase } from '@pcp/database/testing';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { createDeliveries } from './deliveries.js';
import { acknowledge, escalate, ingest, resolveManually, type NormalizedAlert } from './engine.js';

let db: TestDatabase;
let prisma: PrismaClient;
const orgA = randomUUID();
const orgB = randomUUID();
const productA = randomUUID();
const productB = randomUUID();
const T0 = new Date('2026-10-23T10:00:00Z');
const min = (m: number) => new Date(T0.getTime() + m * 60_000);

const ctx = (organizationId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'alerting' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: randomUUID(),
});
const inOrg = <T>(org: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(prisma, ctx(org), fn);

async function sql(text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.superuserUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

async function rule(org: string, product: string, name = 'CPU above 90 %', severity = 'warning') {
  const id = randomUUID();
  await sql(
    `INSERT INTO alert_rules (id, organization_id, product_id, name, template, params, severity, updated_at)
     VALUES ($1, $2, $3, $4, 'host_cpu_high', '{"threshold":90,"forMinutes":10}', $5, now())`,
    [id, org, product, name, severity],
  );
  return id;
}

const firing = (ruleId: string, at: Date, labels: Record<string, string> = {}): NormalizedAlert => ({
  ruleId,
  status: 'firing',
  labels: { agent_id: 'agent-1', alertname: 'host_cpu_high-x', alertgroup: 'g', ...labels },
  startsAt: at,
  value: '97.25',
});
const resolved = (ruleId: string, at: Date, labels: Record<string, string> = {}): NormalizedAlert => ({
  ...firing(ruleId, at, labels),
  status: 'resolved',
  endsAt: at,
});

const incidents = (org: string) =>
  sql(`SELECT * FROM alert_incidents WHERE organization_id = $1 ORDER BY created_at`, [org]);
const events = (incidentId: string) =>
  sql(`SELECT kind, detail FROM incident_events WHERE incident_id = $1 ORDER BY at, kind`, [incidentId]);

beforeAll(async () => {
  db = await startPostgres();
  prisma = createPrismaClient(db.appUrl);
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
  await sql(
    `INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'FireMaps'), ($3, $4, 'Other')`,
    [productA, orgA, productB, orgB],
  );
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.stop();
});

describe('ingest: dedupe, resolve, cooldown (WB-13 UC-13-04/05)', () => {
  it('turns duplicate firings into one incident and asks to notify once (TC-13-03)', async () => {
    const org = randomUUID();
    await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'Dup')`, [org]);
    const product = randomUUID();
    await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P')`, [product, org]);
    const r = await rule(org, product);
    const first = await inOrg(org, (tx) => ingest(tx, org, [firing(r, T0)], T0));
    const second = await inOrg(org, (tx) => ingest(tx, org, [firing(r, T0), firing(r, min(1))], min(1)));
    expect(first.opened).toHaveLength(1);
    expect(first.notify).toEqual([{ incidentId: first.opened[0], event: 'opened' }]);
    expect(second.opened).toEqual([]);
    expect(second.notify).toEqual([]);
    const rows = await incidents(org);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'open', severity: 'warning', product_id: product });
    expect(rows[0].title).toBe('CPU above 90 % on agent-1');
  });

  it('resolves the incident when the alert resolves, and tells the channels once (TC-13-04)', async () => {
    const r = await rule(orgA, productA, 'Memory high');
    const opened = await inOrg(orgA, (tx) => ingest(tx, orgA, [firing(r, T0, { agent_id: 'agent-r' })], T0));
    const id = opened.opened[0]!;
    const res = await inOrg(orgA, (tx) =>
      ingest(tx, orgA, [resolved(r, min(12), { agent_id: 'agent-r' })], min(12)),
    );
    expect(res.resolved).toEqual([id]);
    expect(res.notify).toEqual([{ incidentId: id, event: 'resolved' }]);
    const [row] = await sql(
      `SELECT status, open_fingerprint, resolution_note FROM alert_incidents WHERE id = $1`,
      [id],
    );
    expect(row).toMatchObject({
      status: 'resolved',
      open_fingerprint: null,
      resolution_note: 'Condition cleared',
    });
    // A resolve for an unknown fingerprint changes nothing.
    const none = await inOrg(orgA, (tx) =>
      ingest(tx, orgA, [resolved(r, min(13), { agent_id: 'nobody' })], min(13)),
    );
    expect(none.resolved).toEqual([]);
  });

  it('keeps flapping on one incident with one opening notice and the full timeline (Review Focus #2, TC-13-05)', async () => {
    const r = await rule(orgA, productA, 'Flappy');
    const labels = { agent_id: 'agent-flap' };
    const notices: string[] = [];
    let id = '';
    for (let i = 0; i < 6; i++) {
      const up = await inOrg(orgA, (tx) => ingest(tx, orgA, [firing(r, min(i * 4), labels)], min(i * 4)));
      id ||= up.opened[0]!;
      notices.push(...up.notify.map((n) => n.event));
      const down = await inOrg(orgA, (tx) =>
        ingest(tx, orgA, [resolved(r, min(i * 4 + 2), labels)], min(i * 4 + 2)),
      );
      notices.push(...down.notify.map((n) => n.event));
    }
    expect(notices).toEqual(['opened', 'resolved']);
    const rows = await sql(`SELECT id FROM alert_incidents WHERE rule_id = $1`, [r]);
    expect(rows).toEqual([{ id }]);
    const kinds = (await events(id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'reopened')).toHaveLength(5);
    expect(kinds.filter((k) => k === 'resolved')).toHaveLength(6);
    expect(kinds.filter((k) => k === 'suppressed').length).toBeGreaterThanOrEqual(5);
  });

  it('opens a new incident when the same condition returns after more than 30 minutes', async () => {
    const r = await rule(orgA, productA, 'Later');
    const labels = { agent_id: 'agent-late' };
    const a = await inOrg(orgA, (tx) => ingest(tx, orgA, [firing(r, T0, labels)], T0));
    await inOrg(orgA, (tx) => ingest(tx, orgA, [resolved(r, min(5), labels)], min(5)));
    const b = await inOrg(orgA, (tx) => ingest(tx, orgA, [firing(r, min(36), labels)], min(36)));
    expect(b.opened).toHaveLength(1);
    expect(b.opened[0]).not.toBe(a.opened[0]);
    expect(b.notify).toEqual([{ incidentId: b.opened[0], event: 'opened' }]);
  });

  it('keeps tenants apart even with identical labels', async () => {
    const ra = await rule(orgA, productA, 'Same');
    const rb = await rule(orgB, productB, 'Same');
    await inOrg(orgA, (tx) => ingest(tx, orgA, [firing(ra, T0, { agent_id: 'twin' })], T0));
    await inOrg(orgB, (tx) => ingest(tx, orgB, [firing(rb, T0, { agent_id: 'twin' })], T0));
    // A rule of another organization is not visible in this tenant: the alert is skipped.
    const cross = await inOrg(orgA, (tx) => ingest(tx, orgA, [firing(rb, T0, { agent_id: 'twin' })], T0));
    expect(cross.opened).toEqual([]);
    const a = await sql(`SELECT fingerprint FROM alert_incidents WHERE rule_id = $1`, [ra]);
    const b = await sql(`SELECT fingerprint FROM alert_incidents WHERE rule_id = $1`, [rb]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].fingerprint).not.toBe(b[0].fingerprint);
  });
});

describe('correlation and wording (TC-13-07)', () => {
  it('names the host, lists impacted assets, and never claims a cause', async () => {
    const r = await rule(orgA, productA, 'CPU high');
    const [hostId, apiId, siteId] = [randomUUID(), randomUUID(), randomUUID()];
    await sql(
      `INSERT INTO assets (id, organization_id, asset_type, name, source, identity_key)
       VALUES ($1, $4, 'host', 'vps-orders', 'agent', 'agent:agent-corr'),
              ($2, $4, 'service', 'Orders API', 'agent', 'svc:orders'),
              ($3, $4, 'website', 'shop.example.com', 'product_config', 'website:shop')`,
      [hostId, apiId, siteId, orgA],
    );
    await sql(
      `INSERT INTO product_assets (organization_id, product_id, asset_id) SELECT $1, $2, unnest($3::uuid[])`,
      [orgA, productA, [hostId, apiId, siteId]],
    );
    await sql(
      `INSERT INTO asset_relationships (id, organization_id, source_asset_id, target_asset_id, relationship_type, confidence, verification, updated_at)
       VALUES ($1, $3, $4, $5, 'HOSTS', 0.95, 'verified', now()), ($2, $3, $6, $5, 'DEPENDS_ON', 0.9, 'verified', now())`,
      [randomUUID(), randomUUID(), orgA, hostId, apiId, siteId],
    );
    const res = await inOrg(orgA, (tx) => ingest(tx, orgA, [firing(r, T0, { agent_id: 'agent-corr' })], T0));
    const [row] = await sql(`SELECT title, summary, correlation FROM alert_incidents WHERE id = $1`, [
      res.opened[0],
    ]);
    expect(row.title).toBe('CPU high on vps-orders');
    expect(row.correlation.host).toEqual({ id: hostId, name: 'vps-orders' });
    expect(row.correlation.assets.map((a: { name: string }) => a.name)).toEqual([
      'Orders API',
      'shop.example.com',
    ]);
    expect(row.summary).toContain('CPU high on vps-orders');
    expect(row.summary).toContain('97.3');
    expect(row.summary).toContain(
      'Correlated with 2 assets: Orders API (potential), shop.example.com (potential).',
    );
    expect(row.summary.toLowerCase()).not.toContain('caus');
  });

  it('says so when the graph knows nothing about the host', async () => {
    const r = await rule(orgA, productA, 'Disk');
    const res = await inOrg(orgA, (tx) =>
      ingest(tx, orgA, [firing(r, T0, { agent_id: 'agent-lonely', mountpoint: '/' })], T0),
    );
    const [row] = await sql(`SELECT title, summary FROM alert_incidents WHERE id = $1`, [res.opened[0]]);
    expect(row.title).toBe('Disk on agent-lonely (/)');
    expect(row.summary).toContain('No related assets are known in the asset graph yet.');
  });
});

describe('acknowledge, manual resolve, escalation (UC-13-06/07/08)', () => {
  it('acknowledges once and resolves manually with a note', async () => {
    const r = await rule(orgA, productA, 'Ack');
    const user = randomUUID();
    const { opened } = await inOrg(orgA, (tx) =>
      ingest(tx, orgA, [firing(r, T0, { agent_id: 'agent-ack' })], T0),
    );
    const id = opened[0]!;
    await inOrg(orgA, (tx) => acknowledge(tx, id, user, min(2)));
    await expect(inOrg(orgA, (tx) => acknowledge(tx, id, user, min(3)))).rejects.toThrow(/not open/);
    await inOrg(orgA, (tx) => resolveManually(tx, id, user, 'Restarted the worker', min(5)));
    const [row] = await sql(
      `SELECT status, acknowledged_by_user_id, resolution_note, open_fingerprint FROM alert_incidents WHERE id = $1`,
      [id],
    );
    expect(row).toMatchObject({
      status: 'resolved',
      acknowledged_by_user_id: user,
      resolution_note: 'Restarted the worker',
      open_fingerprint: null,
    });
    expect((await events(id)).map((e) => e.kind)).toEqual(
      expect.arrayContaining(['acknowledged', 'resolved']),
    );
  });

  it('escalates critical incidents unacknowledged for 15 minutes, once (TC-13-06)', async () => {
    const crit = await rule(orgA, productA, 'Down', 'critical');
    const warn = await rule(orgA, productA, 'Meh', 'warning');
    const a = await inOrg(orgA, (tx) =>
      ingest(
        tx,
        orgA,
        [firing(crit, T0, { agent_id: 'agent-esc' }), firing(warn, T0, { agent_id: 'agent-esc' })],
        T0,
      ),
    );
    expect(await inOrg(orgA, (tx) => escalate(tx, min(14)))).toEqual([]);
    const due = await inOrg(orgA, (tx) => escalate(tx, min(16)));
    const critId = (await sql(`SELECT id FROM alert_incidents WHERE rule_id = $1`, [crit]))[0].id;
    expect(due).toEqual([{ incidentId: critId, event: 'escalated' }]);
    expect(await inOrg(orgA, (tx) => escalate(tx, min(40)))).toEqual([]);
    expect(a.opened).toHaveLength(2);
  });
});

describe('createDeliveries (UC-13-05/07)', () => {
  it('fans out to active channels, escalations only to escalation channels when any are marked', async () => {
    const org = randomUUID();
    await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'Fan')`, [org]);
    const product = randomUUID();
    await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P')`, [product, org]);
    const [mail, pager, broken] = [randomUUID(), randomUUID(), randomUUID()];
    await sql(
      `INSERT INTO notification_channels (id, organization_id, name, kind, escalation, status, updated_at)
       VALUES ($1, $4, 'Mail', 'email', false, 'active', now()),
              ($2, $4, 'Pager', 'webhook', true, 'active', now()),
              ($3, $4, 'Old', 'slack', false, 'broken', now())`,
      [mail, pager, broken, org],
    );
    const r = await rule(org, product, 'Fan', 'critical');
    const { opened } = await inOrg(org, (tx) => ingest(tx, org, [firing(r, T0)], T0));
    const id = opened[0]!;
    const ids = await inOrg(org, (tx) =>
      createDeliveries(tx, org, [
        { incidentId: id, event: 'opened' },
        { incidentId: id, event: 'escalated' },
      ]),
    );
    expect(ids).toHaveLength(3);
    const key = (x: { event: string; channel_id: string }) => `${x.event}/${x.channel_id}`;
    const rows = (
      await sql(`SELECT channel_id, event FROM notification_deliveries WHERE incident_id = $1`, [id])
    ).map(key);
    expect(rows.sort()).toEqual(
      [
        { channel_id: mail, event: 'opened' },
        { channel_id: pager, event: 'opened' },
        { channel_id: pager, event: 'escalated' },
      ]
        .map(key)
        .sort(),
    );
  });
});
