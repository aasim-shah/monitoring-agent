import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, TEST_PASSWORDS, type TestDatabase } from './testing.js';
import { withCredentials } from './urls.js';

let db: TestDatabase;
const org = randomUUID();
const member = randomUUID();
const connection = randomUUID();

async function query<T extends pg.QueryResultRow>(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(text, values)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await startPostgres();
  await query(db.superuserUrl, `INSERT INTO users (id, email) VALUES ($1, 'm@example.com')`, [member]);
  await query(db.superuserUrl, `INSERT INTO organizations (id, name) VALUES ($1, 'Org')`, [org]);
  await query(
    db.superuserUrl,
    `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
    [randomUUID(), org, member],
  );
  await query(
    db.superuserUrl,
    `INSERT INTO connections (id, organization_id, provider, display_name, execution_location, updated_at)
     VALUES ($1, $2, 'mock', 'Mock', 'cloud', now())`,
    [connection, org],
  );
  await query(
    db.superuserUrl,
    `INSERT INTO job_definitions (id, organization_id, kind, entity_id, every_seconds) VALUES ($1, $2, 'connection-validate', $3, 900)`,
    [randomUUID(), org, connection],
  );
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('connections data model', () => {
  it('resolves a connection organization only for members', async () => {
    const [m] = await query<{ org: string }>(db.appUrl, `SELECT pcp_resolve_connection_org($1, $2) AS org`, [
      connection,
      member,
    ]);
    expect(m!.org).toBe(org);
    const [s] = await query<{ org: string | null }>(
      db.appUrl,
      `SELECT pcp_resolve_connection_org($1, $2) AS org`,
      [connection, randomUUID()],
    );
    expect(s!.org).toBeNull();
  });

  it('lets pcp_scheduler list due job definitions only through its function', async () => {
    const scheduler = withCredentials(db.superuserUrl, 'pcp_scheduler', TEST_PASSWORDS.scheduler);
    const rows = await query<{ kind: string; entity_id: string }>(
      scheduler,
      `SELECT kind, entity_id FROM pcp_due_job_definitions()`,
    );
    expect(rows).toEqual([{ kind: 'connection-validate', entity_id: connection }]);
    await expect(query(scheduler, `SELECT * FROM job_definitions`)).rejects.toThrow(/permission denied/);
  });

  it('stores only ciphertext for connection secrets', async () => {
    const cols = await query<{ column_name: string }>(
      db.superuserUrl,
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'connection_secrets' ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'ciphertext',
      'connection_id',
      'created_at',
      'key_version',
      'organization_id',
      'rotated_at',
    ]);
  });
});
