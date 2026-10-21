import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import { startPostgres, type TestDatabase } from '@pcp/database/testing';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from './index.js';

let db: TestDatabase;
const orgA = randomUUID();
const orgB = randomUUID();
const clients: PrismaClient[] = [];

const ctx = (organizationId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'user', userId: randomUUID() },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: randomUUID(),
});

function client(poolSize: number): PrismaClient {
  const c = createPrismaClient(db.appUrlWithPool(poolSize));
  clients.push(c);
  return c;
}

const productOrgs = async (tx: { $queryRaw: PrismaClient['$queryRaw'] }) =>
  (await tx.$queryRaw<{ org: string }[]>`SELECT DISTINCT organization_id::text AS org FROM products`).map(
    (r) => r.org,
  );

beforeAll(async () => {
  db = await startPostgres();
  const su = new pg.Client({ connectionString: db.superuserUrl });
  await su.connect();
  for (const org of [orgA, orgB]) {
    await su.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [org, `Org ${org}`]);
    await su.query(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P')`, [
      randomUUID(),
      org,
    ]);
  }
  await su.end();
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()));
  await db?.stop();
});

describe('withTenant (Review Focus #1)', () => {
  it('scopes queries to the tenant and leaves a pooled connection clean afterwards', async () => {
    const prisma = client(1);
    expect(await withTenant(prisma, ctx(orgA), productOrgs)).toEqual([orgA]);

    const [setting] = await prisma.$queryRaw<{ v: string | null }[]>`
      SELECT current_setting('app.organization_id', true) AS v`;
    expect(setting!.v ?? '').toBe('');
    expect(await productOrgs(prisma)).toEqual([]);
  });

  it('never mixes tenants across 50 interleaved transactions', async () => {
    const prisma = client(5);
    const runs = Array.from({ length: 50 }, (_, i) => {
      const org = i % 2 === 0 ? orgA : orgB;
      return withTenant(prisma, ctx(org), async (tx) => {
        await tx.$executeRaw`SELECT pg_sleep(0.01)`;
        return { org, seen: await productOrgs(tx) };
      });
    });
    for (const { org, seen } of await Promise.all(runs)) expect(seen).toEqual([org]);
  });

  it('an error inside withTenant leaves the next borrower clean', async () => {
    const prisma = client(1);
    await expect(
      withTenant(prisma, ctx(orgA), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await productOrgs(prisma)).toEqual([]);
  });

  it('sets app.user_id for user actors', async () => {
    const prisma = client(1);
    const c = ctx(orgA);
    const [row] = await withTenant(
      prisma,
      c,
      (tx) => tx.$queryRaw<{ v: string }[]>`SELECT current_setting('app.user_id', true) AS v`,
    );
    expect(row!.v).toBe(c.actor.kind === 'user' ? c.actor.userId : '');
  });
});
