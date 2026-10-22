import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const orgA = randomUUID();
const orgB = randomUUID();

async function query(text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.superuserUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

const asset = (org: string, key: string) =>
  query(
    `INSERT INTO assets (id, organization_id, asset_type, name, source, identity_key) VALUES ($1, $2, 'host', 'vps-1', 'agent', $3)`,
    [randomUUID(), org, key],
  );

beforeAll(async () => {
  db = await startPostgres();
  await query(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('asset identity (BR-10-01)', () => {
  it('is unique within an organization and never shared across organizations', async () => {
    await asset(orgA, 'domain:shop.example.com');
    await asset(orgB, 'domain:shop.example.com'); // same hostname, other tenant: separate asset
    await expect(asset(orgA, 'domain:shop.example.com')).rejects.toThrow(/duplicate key/);
    const rows = await query(
      `SELECT count(*)::int AS n FROM assets WHERE identity_key = 'domain:shop.example.com'`,
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('keeps one edge per source, target, and type', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await query(
      `INSERT INTO assets (id, organization_id, asset_type, name, source, identity_key) VALUES ($1, $3, 'host', 'h', 'agent', $4), ($2, $3, 'service', 's', 'agent', $5)`,
      [a, b, orgA, `agent:${a}`, `svc:${b}`],
    );
    const edge = () =>
      query(
        `INSERT INTO asset_relationships (id, organization_id, source_asset_id, target_asset_id, relationship_type, confidence, updated_at) VALUES ($1, $2, $3, $4, 'HOSTS', 0.95, now())`,
        [randomUUID(), orgA, a, b],
      );
    await edge();
    await expect(edge()).rejects.toThrow(/duplicate key/);
  });
});
