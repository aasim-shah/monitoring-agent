import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const [orgA, orgB, orgC] = [randomUUID(), randomUUID(), randomUUID()];
const [productA, productB, productC] = [randomUUID(), randomUUID(), randomUUID()];
const ruleA = randomUUID();

const schedulerUrl = () => {
  const u = new URL(db.superuserUrl);
  u.username = 'pcp_scheduler';
  u.password = 'test-scheduler';
  return u.toString();
};

async function run(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await startPostgres();
  const su = (q: string, v: unknown[] = []) => run(db.superuserUrl, q, v);
  await su(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B'), ($3, 'C')`, [orgA, orgB, orgC]);
  await su(
    `INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P'), ($3, $4, 'P'), ($5, $6, 'P')`,
    [productA, orgA, productB, orgB, productC, orgC],
  );
  // A: an enabled rule. B: only a disabled rule but an open critical incident. C: nothing active.
  await su(
    `INSERT INTO alert_rules (id, organization_id, product_id, name, template, params, severity, enabled, updated_at)
     VALUES ($1, $2, $3, 'Heartbeat', 'agent_heartbeat_missing', '{}', 'critical', true, now()),
            ($4, $5, $6, 'Off', 'host_cpu_high', '{}', 'warning', false, now()),
            ($7, $8, $9, 'Off', 'host_cpu_high', '{}', 'warning', false, now())`,
    [ruleA, orgA, productA, randomUUID(), orgB, productB, randomUUID(), orgC, productC],
  );
  const ruleB = (await su(`SELECT id FROM alert_rules WHERE organization_id = $1`, [orgB]))[0]!.id;
  await su(
    `INSERT INTO alert_incidents (id, organization_id, product_id, rule_id, fingerprint, title, severity, status, started_at)
     VALUES ($1, $2, $3, $4, 'fp-b', 'Down', 'critical', 'open', now())`,
    [randomUUID(), orgB, productB, ruleB],
  );
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('alerting cross-tenant functions', () => {
  it('pcp_alerting_orgs lists organizations with enabled rules or open critical incidents (scheduler role)', async () => {
    const rows = await run(schedulerUrl(), `SELECT organization_id FROM pcp_alerting_orgs()`);
    expect(rows.map((r) => r.organization_id).sort()).toEqual([orgA, orgB].sort());
  });

  it('pcp_resolve_alert_rule_org returns a rule organization to the app role, and nothing for unknown rules', async () => {
    expect((await run(db.appUrl, `SELECT pcp_resolve_alert_rule_org($1) AS org`, [ruleA]))[0]!.org).toBe(
      orgA,
    );
    expect(
      (await run(db.appUrl, `SELECT pcp_resolve_alert_rule_org($1) AS org`, [randomUUID()]))[0]!.org,
    ).toBeNull();
  });

  it('keeps one unresolved incident per fingerprint', async () => {
    const insert = () =>
      run(
        db.superuserUrl,
        `INSERT INTO alert_incidents (id, organization_id, product_id, rule_id, fingerprint, open_fingerprint, title, severity, started_at)
         VALUES ($1, $2, $3, $4, 'fp-a', 'fp-a', 'CPU', 'warning', now())`,
        [randomUUID(), orgA, productA, ruleA],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
    await run(
      db.superuserUrl,
      `UPDATE alert_incidents SET status = 'resolved', open_fingerprint = NULL WHERE fingerprint = 'fp-a'`,
    );
    await insert(); // a resolved incident no longer blocks a new one
  });
});
