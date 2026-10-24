import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const [orgA, orgB, connA] = [randomUUID(), randomUUID(), randomUUID()];

async function run(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

async function asTenant(org: string, text: string) {
  const c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.organization_id', $1, true)`, [org]);
    const rows = (await c.query(text)).rows;
    await c.query('COMMIT');
    return rows;
  } finally {
    await c.end();
  }
}

const su = (q: string, v: unknown[] = []) => run(db.superuserUrl, q, v);
const point = (day: string, value: number | null) =>
  su(
    `INSERT INTO metric_aggregates (organization_id, connection_id, resource_type, external_id, metric, day, value, completeness)
     VALUES ($1, $2, 'google_ga4_property', 'properties/1', 'activeUsers', $3, $4, 'complete')`,
    [orgA, connA, day, value],
  );

beforeAll(async () => {
  db = await startPostgres();
  await su(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
  await su(
    `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, updated_at)
     VALUES ($1, $2, 'google', 'Google', 'connected', 'cloud', now())`,
    [connA, orgA],
  );
  await point('2026-10-24', 120);
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('KPI schema (WB-08 §6, WB-09 §6)', () => {
  it('isolates metric aggregates per organization', async () => {
    expect((await asTenant(orgB, `SELECT count(*)::int AS n FROM metric_aggregates`))[0]!.n).toBe(0);
    expect((await asTenant(orgA, `SELECT count(*)::int AS n FROM metric_aggregates`))[0]!.n).toBe(1);
  });

  it('keeps one value per connection, resource, metric, dimension, and day', async () => {
    await expect(point('2026-10-24', 130)).rejects.toThrow(/duplicate key/);
  });

  it('records granted Google scopes and the account on the connection', async () => {
    const [row] = await su(`SELECT granted_scopes, account_email FROM connections WHERE id = $1`, [connA]);
    expect(row).toEqual({ granted_scopes: [], account_email: null });
  });
});
