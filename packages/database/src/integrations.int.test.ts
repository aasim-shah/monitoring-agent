import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const [orgA, orgB, connA, connB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

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

beforeAll(async () => {
  db = await startPostgres();
  await su(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
  await su(
    `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, updated_at)
     VALUES ($1, $2, 'github', 'GH', 'connected', 'cloud', now()), ($3, $4, 'github', 'GH', 'connected', 'cloud', now())`,
    [connA, orgA, connB, orgB],
  );
  await su(
    `INSERT INTO webhook_deliveries (organization_id, connection_id, provider, delivery_id, event_type, result)
     VALUES ($1, $2, 'github', 'd-1', 'deployment_status', 'processed')`,
    [orgA, connA],
  );
  await su(
    `INSERT INTO change_events (organization_id, connection_id, provider, kind, title, occurred_at, external_id)
     VALUES ($1, $2, 'github', 'deployment', 'Deployed main to production', now(), 'dep-1')`,
    [orgA, connA],
  );
  await su(
    `INSERT INTO connection_inventory (organization_id, connection_id, resource_type, external_id, name)
     VALUES ($1, $2, 'github_repository', 'r-1', 'acme/shop')`,
    [orgA, connA],
  );
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('integrations schema (WB-06 §6)', () => {
  it('isolates deliveries, change events, and inventory per organization', async () => {
    for (const table of ['webhook_deliveries', 'change_events', 'connection_inventory']) {
      expect((await asTenant(orgB, `SELECT count(*)::int AS n FROM ${table}`))[0]!.n, table).toBe(0);
      expect((await asTenant(orgA, `SELECT count(*)::int AS n FROM ${table}`))[0]!.n, table).toBe(1);
    }
  });

  it('records a provider delivery once (BR-06-05)', async () => {
    await expect(
      su(
        `INSERT INTO webhook_deliveries (organization_id, connection_id, provider, delivery_id, event_type, result)
         VALUES ($1, $2, 'github', 'd-1', 'deployment_status', 'processed')`,
        [orgA, connA],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('keeps one change event per connection, kind, and external ID', async () => {
    await expect(
      su(
        `INSERT INTO change_events (organization_id, connection_id, provider, kind, title, occurred_at, external_id)
         VALUES ($1, $2, 'github', 'deployment', 'again', now(), 'dep-1')`,
        [orgA, connA],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('keeps one inventory row per connection, type, and external ID', async () => {
    await expect(
      su(
        `INSERT INTO connection_inventory (organization_id, connection_id, resource_type, external_id, name)
         VALUES ($1, $2, 'github_repository', 'r-1', 'dup')`,
        [orgA, connA],
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});
