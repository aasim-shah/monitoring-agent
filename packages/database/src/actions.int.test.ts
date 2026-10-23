import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const [orgA, orgB] = [randomUUID(), randomUUID()];
const [productA, productB, envA, envB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const [policyA, requestA] = [randomUUID(), randomUUID()];

async function run(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

async function asTenant(org: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.organization_id', $1, true)`, [org]);
    const rows = (await c.query(text, values)).rows;
    await c.query('COMMIT');
    return rows;
  } finally {
    await c.end();
  }
}

const request = (id: string, org: string, product: string, env: string, key: string, idem: string) =>
  run(
    db.superuserUrl,
    `INSERT INTO action_requests (id, organization_id, product_id, environment_id, capability, target, target_key, params, status, idempotency_key, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, 'host.restart_service', '{}', $5, '{}', 'approved', $6, now() + interval '1 hour', now())`,
    [id, org, product, env, key, idem],
  );

beforeAll(async () => {
  db = await startPostgres();
  const su = (q: string, v: unknown[] = []) => run(db.superuserUrl, q, v);
  await su(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
  await su(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P'), ($3, $4, 'P')`, [
    productA,
    orgA,
    productB,
    orgB,
  ]);
  await su(
    `INSERT INTO environments (id, organization_id, product_id, name) VALUES ($1, $2, $3, 'production'), ($4, $5, $6, 'production')`,
    [envA, orgA, productA, envB, orgB, productB],
  );
  await su(
    `INSERT INTO action_policies (id, organization_id, product_id, environment_id, capability, updated_at)
     VALUES ($1, $2, $3, $4, 'host.restart_service', now())`,
    [policyA, orgA, productA, envA],
  );
  await request(requestA, orgA, productA, envA, 'host.restart_service:a1:api.service', 'idem-1');
  await su(
    `INSERT INTO action_approvals (organization_id, request_id, user_id, decision) VALUES ($1, $2, $3, 'approve')`,
    [orgA, requestA, randomUUID()],
  );
  await su(
    `INSERT INTO action_executions (organization_id, request_id, target_key, running_key, location, adapter, adapter_version, status)
     VALUES ($1, $2, 'host.restart_service:a1:api.service', 'host.restart_service:a1:api.service', 'agent', 'host.restart_service', '0.3.0', 'running')`,
    [orgA, requestA],
  );
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('actions schema (WB-16 §6)', () => {
  it('isolates policies, requests, approvals, and executions per organization', async () => {
    for (const table of ['action_policies', 'action_requests', 'action_approvals', 'action_executions']) {
      expect((await asTenant(orgB, `SELECT count(*)::int AS n FROM ${table}`))[0]!.n, table).toBe(0);
      expect((await asTenant(orgA, `SELECT count(*)::int AS n FROM ${table}`))[0]!.n, table).toBe(1);
    }
  });

  it('policies default to disabled with approval required (BR-16-01)', async () => {
    const [p] = await run(
      db.superuserUrl,
      `SELECT enabled, require_approval FROM action_policies WHERE id = $1`,
      [policyA],
    );
    expect(p).toEqual({ enabled: false, require_approval: true });
  });

  it('allows one running execution per target (BR-16-06)', async () => {
    const other = randomUUID();
    await request(other, orgA, productA, envA, 'host.restart_service:a1:api.service', 'idem-2');
    await expect(
      run(
        db.superuserUrl,
        `INSERT INTO action_executions (organization_id, request_id, target_key, running_key, location, adapter, adapter_version, status)
         VALUES ($1, $2, 'host.restart_service:a1:api.service', 'host.restart_service:a1:api.service', 'agent', 'host.restart_service', '0.3.0', 'running')`,
        [orgA, other],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('keeps idempotency keys unique per organization', async () => {
    await expect(
      request(randomUUID(), orgA, productA, envA, 'host.restart_service:a1:x.service', 'idem-1'),
    ).rejects.toThrow(/duplicate key/);
    await request(randomUUID(), orgB, productB, envB, 'host.restart_service:b1:x.service', 'idem-1');
  });

  it('pcp_resolve_action_object answers members only, with the product', async () => {
    const user = randomUUID();
    await run(db.superuserUrl, `INSERT INTO users (id, email) VALUES ($1, $2)`, [
      user,
      `${user}@example.com`,
    ]);
    await run(
      db.superuserUrl,
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`,
      [randomUUID(), orgA, user],
    );
    const q = (kind: string, id: string, u: string) =>
      run(db.appUrl, `SELECT organization_id, product_id FROM pcp_resolve_action_object($1, $2, $3)`, [
        kind,
        id,
        u,
      ]);
    expect(await q('action_request', requestA, user)).toEqual([
      { organization_id: orgA, product_id: productA },
    ]);
    expect(await q('action_policy', policyA, user)).toEqual([
      { organization_id: orgA, product_id: productA },
    ]);
    expect(await q('action_request', requestA, randomUUID())).toEqual([]);
  });
});
