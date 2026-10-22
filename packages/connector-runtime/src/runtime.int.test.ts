import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorRegistry } from '@pcp/connector-sdk';
import { mockConnector } from '@pcp/connectors-mock';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import { startPostgres, type TestDatabase } from '@pcp/database/testing';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ConnectorRuntime, NotFoundError, storeCredentials } from './index.js';

const TOKEN = 'mock-secret-token-123';
let db: TestDatabase;
let prisma: PrismaClient;
let runtime: ConnectorRuntime;
const keyRing = (() => {
  const key = randomBytes(32);
  return { active: { version: 1, key }, ring: new Map([[1, key]]) };
})();
const orgA = randomUUID();
const orgB = randomUUID();
const p1 = randomUUID();
const p2 = randomUUID();

const ctx = (organizationId: string, productIds: string[] | 'all' = 'all'): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'test' },
  roles: ['owner'],
  productIds,
  environmentIds: 'all',
  requestId: randomUUID(),
});

async function sql(text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.superuserUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

/** Creates a mock connection in org A with stored credentials. */
async function connection(behavior: string, scopeProduct?: string): Promise<string> {
  const id = randomUUID();
  await withTenant(prisma, ctx(orgA), async (tx) => {
    await tx.connection.create({
      data: {
        id,
        organizationId: orgA,
        provider: 'mock',
        displayName: `Mock ${behavior}`,
        executionLocation: 'cloud',
        status: 'pending_validation',
        config: { behavior },
      },
    });
    await storeCredentials(tx, ctx(orgA), id, { token: TOKEN }, keyRing);
    if (scopeProduct) {
      await tx.connectionResourceScope.create({
        data: {
          organizationId: orgA,
          connectionId: id,
          externalId: 'mock-1',
          resourceType: 'mock_resource',
          name: 'R',
          productId: scopeProduct,
        },
      });
    }
  });
  return id;
}

beforeAll(async () => {
  db = await startPostgres();
  prisma = createPrismaClient(db.appUrl);
  for (const [org, name] of [
    [orgA, 'A'],
    [orgB, 'B'],
  ]) {
    await sql(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [org, name]);
  }
  await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $3, 'P1'), ($2, $3, 'P2')`, [
    p1,
    p2,
    orgA,
  ]);
  const registry = new ConnectorRegistry();
  registry.register(mockConnector);
  runtime = new ConnectorRuntime(prisma, registry, keyRing);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.stop();
});

describe('ConnectorRuntime scope', () => {
  it('does not find another organization connection', async () => {
    const id = await connection('ok');
    await expect(runtime.validate(ctx(orgB), id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('limits product-scoped callers to connections scoped to their products (Review Focus #2)', async () => {
    const id = await connection('ok', p1);
    await expect(runtime.validate(ctx(orgA, [p2]), id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(runtime.validate(ctx(orgA, [p1]), id)).resolves.toMatchObject({ status: 'connected' });
  });
});

describe('ConnectorRuntime.validate', () => {
  it.each([
    ['ok', 'connected', null],
    ['unauthorized', 'degraded', 'reauthorization_required'],
    ['forbidden', 'degraded', 'permission_denied'],
    ['unavailable', 'degraded', 'provider_unavailable'],
  ])('%s → %s (%s)', async (behavior, status, reason) => {
    const id = await connection(behavior);
    const result = await runtime.validate(ctx(orgA), id);
    expect(result.status).toBe(status);
    const row = await withTenant(prisma, ctx(orgA), (tx) =>
      tx.connection.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.status).toBe(status);
    expect(row.statusReason).toBe(reason);
    if (behavior === 'forbidden') expect(result.missingPermissions).toEqual(['mock:read']);
  });

  it('keeps the status but records rate limiting', async () => {
    const id = await connection('rate_limited');
    const result = await runtime.validate(ctx(orgA), id);
    expect(result).toMatchObject({
      status: 'pending_validation',
      reason: 'rate_limited',
      retryAfterSeconds: 30,
    });
  });

  it('redacts credentials from provider errors before storing them (Review Focus #1)', async () => {
    const id = await connection('leaky');
    const result = await runtime.validate(ctx(orgA), id);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const [health] = await sql(`SELECT detail FROM connection_health WHERE connection_id = $1`, [id]);
    expect(health.detail).toContain('[REDACTED]');
    expect(health.detail).not.toContain(TOKEN);
  });

  it('treats credentials that fail to decrypt as needing reauthorization', async () => {
    const good = await connection('ok');
    const victim = await connection('ok');
    await sql(
      `UPDATE connection_secrets SET ciphertext = (SELECT ciphertext FROM connection_secrets WHERE connection_id = $1) WHERE connection_id = $2`,
      [good, victim],
    );
    await expect(runtime.validate(ctx(orgA), victim)).resolves.toMatchObject({
      status: 'degraded',
      reason: 'reauthorization_required',
    });
  });

  it('never revives a disconnected connection', async () => {
    const id = await connection('ok');
    await sql(`UPDATE connections SET status = 'disconnected' WHERE id = $1`, [id]);
    await expect(runtime.validate(ctx(orgA), id)).resolves.toMatchObject({ status: 'disconnected' });
  });
});

describe('credential storage', () => {
  it('stores concurrent credential submissions without a unique-key race', async () => {
    const id = await connection('ok');
    await sql(`DELETE FROM connection_secrets WHERE connection_id = $1`, [id]);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        withTenant(prisma, ctx(orgA), (tx) =>
          storeCredentials(tx, ctx(orgA), id, { token: `${TOKEN}-${i}` }, keyRing),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await sql(`SELECT 1 FROM connection_secrets WHERE connection_id = $1`, [id])).toHaveLength(1);
  });

  it('leaves no plaintext credential anywhere in the database', async () => {
    await connection('ok');
    const tables = await sql(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    for (const { tablename } of tables) {
      const rows = await sql(`SELECT row_to_json(t)::text AS j FROM ${tablename} t`);
      for (const { j } of rows) expect(j, tablename).not.toContain(TOKEN);
    }
  });
});

describe('ConnectorRuntime.discover', () => {
  it('returns observations from the connector', async () => {
    const id = await connection('ok');
    const page = await runtime.discover(ctx(orgA), id);
    expect(page.observations.map((o) => o.externalId)).toEqual(['mock-1', 'mock-2']);
  });
});
