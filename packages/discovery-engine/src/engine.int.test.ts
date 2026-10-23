import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import { startPostgres, type TestDatabase } from '@pcp/database/testing';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { completeRun, contradictEdge, ingestObservation, proposeEdge, startRun } from './index.js';

let db: TestDatabase;
let prisma: PrismaClient;
const orgA = randomUUID();
const orgB = randomUUID();
const productA = randomUUID();

const ctx = (organizationId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'discovery' },
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

beforeAll(async () => {
  db = await startPostgres();
  prisma = createPrismaClient(db.appUrl);
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')`, [orgA, orgB]);
  await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'FireMaps')`, [productA, orgA]);
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.stop();
});

const host = (key: string, name = 'vps-1') => ({
  source: 'agent' as const,
  assetType: 'host' as const,
  identity: { kind: 'stable' as const, key },
  name,
  attributes: { ip: '203.0.113.7', password: 'nope' },
  productId: productA,
});

describe('ingestObservation (UC-10-01)', () => {
  it('never shares an asset across organizations (TC-10-01)', async () => {
    const a = await inOrg(orgA, (tx) =>
      ingestObservation(tx, orgA, { ...host('domain:shop.example.com'), productId: undefined }),
    );
    const b = await inOrg(orgB, (tx) =>
      ingestObservation(tx, orgB, { ...host('domain:shop.example.com'), productId: undefined }),
    );
    expect(a.assetId).not.toBe(b.assetId);
    expect(a.created && b.created).toBe(true);
  });

  it('refreshes a known asset, stores redacted attributes, and links the product', async () => {
    const key = `agent:${randomUUID()}`;
    const first = await inOrg(orgA, (tx) => ingestObservation(tx, orgA, host(key)));
    const again = await inOrg(orgA, (tx) => ingestObservation(tx, orgA, host(key)));
    expect(again).toMatchObject({ assetId: first.assetId, created: false });
    const [row] = await sql(`SELECT lifecycle, attributes FROM assets WHERE id = $1`, [first.assetId]);
    expect(row).toMatchObject({
      lifecycle: 'active',
      attributes: { ip: '203.0.113.7', password: '[redacted]' },
    });
    const links = await sql(`SELECT count(*)::int AS n FROM product_assets WHERE asset_id = $1`, [
      first.assetId,
    ]);
    expect(links[0]!.n).toBe(1);
    const obs = await sql(`SELECT count(*)::int AS n FROM asset_observations WHERE asset_id = $1`, [
      first.assetId,
    ]);
    expect(obs[0]!.n).toBe(2);
  });

  it('never merges on a name: a second asset and an alias candidate (TC-10-02)', async () => {
    const name = `api-${randomUUID().slice(0, 6)}`;
    const one = await inOrg(orgA, (tx) => ingestObservation(tx, orgA, host(`agent:${randomUUID()}`, name)));
    const two = await inOrg(orgA, (tx) => ingestObservation(tx, orgA, host(`agent:${randomUUID()}`, name)));
    expect(two.assetId).not.toBe(one.assetId);
    expect(two.aliasCandidateId).toBeDefined();
    const weak = await inOrg(orgA, (tx) =>
      ingestObservation(tx, orgA, { ...host('x'), identity: { kind: 'weak', name } }),
    );
    expect(weak.created).toBe(true);
    expect(weak.aliasCandidateId).toBeDefined();
  });
});

describe('merged assets', () => {
  it('routes observations of a merged identity to the asset it was merged into', async () => {
    const kept = await inOrg(orgA, (tx) =>
      ingestObservation(tx, orgA, host(`agent:${randomUUID()}`, 'kept')),
    );
    const key = `agent:${randomUUID()}`;
    const dup = await inOrg(orgA, (tx) => ingestObservation(tx, orgA, host(key, 'dup')));
    await sql(
      `UPDATE assets SET lifecycle = 'retired', attributes = jsonb_build_object('mergedInto', $2::text) WHERE id = $1`,
      [dup.assetId, kept.assetId],
    );
    const again = await inOrg(orgA, (tx) => ingestObservation(tx, orgA, host(key, 'dup')));
    expect(again).toMatchObject({ assetId: kept.assetId, created: false });
    const [row] = await sql(`SELECT lifecycle FROM assets WHERE id = $1`, [dup.assetId]);
    expect(row!.lifecycle).toBe('retired');
    const [k] = await sql(`SELECT name FROM assets WHERE id = $1`, [kept.assetId]);
    expect(k!.name).toBe('kept');
  });
});

describe('edges (UC-10-03, BR-10-03/04)', () => {
  const pair = async () => {
    const s = await inOrg(orgA, (tx) =>
      ingestObservation(tx, orgA, host(`agent:${randomUUID()}`, `s-${randomUUID()}`)),
    );
    const t = await inOrg(orgA, (tx) =>
      ingestObservation(tx, orgA, {
        ...host(`svc:${randomUUID()}`, `t-${randomUUID()}`),
        assetType: 'service',
      }),
    );
    return [s.assetId, t.assetId] as const;
  };

  it('verifies only direct evidence at ≥ 0.9; name similarity stays proposed (TC-10-04)', async () => {
    const [s, t] = await pair();
    const direct = await inOrg(orgA, (tx) =>
      proposeEdge(tx, orgA, {
        source: s,
        target: t,
        type: 'HOSTS',
        confidence: 0.95,
        evidenceKind: 'direct',
        direct: true,
        ruleId: 'host-to-service',
      }),
    );
    expect(direct.verification).toBe('verified');
    const [a, b] = await pair();
    const name = await inOrg(orgA, (tx) =>
      proposeEdge(tx, orgA, {
        source: a,
        target: b,
        type: 'CONNECTS_TO',
        confidence: 0.3,
        evidenceKind: 'name',
        direct: false,
        ruleId: 'name-similarity',
      }),
    );
    expect(name.verification).toBe('proposed');
    const ip = await inOrg(orgA, (tx) =>
      proposeEdge(tx, orgA, {
        source: a,
        target: b,
        type: 'CONNECTS_TO',
        confidence: 0.8,
        evidenceKind: 'ip_match',
        direct: false,
        ruleId: 'x',
      }),
    );
    expect(ip).toMatchObject({ id: name.id, verification: 'proposed', created: false });
    const [row] = await sql(`SELECT confidence::float AS c FROM asset_relationships WHERE id = $1`, [
      name.id,
    ]);
    expect(row!.c).toBe(0.8);
    const ev = await sql(`SELECT count(*)::int AS n FROM relationship_evidence WHERE relationship_id = $1`, [
      name.id,
    ]);
    expect(ev[0]!.n).toBe(2);
  });

  it('a rejected edge stays rejected on weak evidence and returns to proposed on strong direct evidence', async () => {
    const [s, t] = await pair();
    const e = await inOrg(orgA, (tx) =>
      proposeEdge(tx, orgA, {
        source: s,
        target: t,
        type: 'ROUTES_TO',
        confidence: 0.8,
        evidenceKind: 'ip_match',
        direct: false,
        ruleId: 'dns-to-host',
      }),
    );
    await sql(`UPDATE asset_relationships SET verification = 'rejected' WHERE id = $1`, [e.id]);
    const weak = await inOrg(orgA, (tx) =>
      proposeEdge(tx, orgA, {
        source: s,
        target: t,
        type: 'ROUTES_TO',
        confidence: 0.8,
        evidenceKind: 'ip_match',
        direct: false,
        ruleId: 'dns-to-host',
      }),
    );
    expect(weak.verification).toBe('rejected');
    const strong = await inOrg(orgA, (tx) =>
      proposeEdge(tx, orgA, {
        source: s,
        target: t,
        type: 'ROUTES_TO',
        confidence: 0.95,
        evidenceKind: 'direct',
        direct: true,
        ruleId: 'x',
      }),
    );
    expect(strong.verification).toBe('proposed');
  });

  it('contradiction drifts a verified edge and never deletes it (TC-10-05)', async () => {
    const [s, t] = await pair();
    const e = await inOrg(orgA, (tx) =>
      proposeEdge(tx, orgA, {
        source: s,
        target: t,
        type: 'HOSTS',
        confidence: 0.95,
        evidenceKind: 'direct',
        direct: true,
        ruleId: 'host-to-service',
      }),
    );
    await expect(inOrg(orgA, (tx) => contradictEdge(tx, orgA, e.id, { reason: 'ip changed' }))).resolves.toBe(
      'drifted',
    );
    const [row] = await sql(`SELECT verification FROM asset_relationships WHERE id = $1`, [e.id]);
    expect(row!.verification).toBe('drifted');
  });
});

describe('lifecycle (UC-10-08, TC-10-03)', () => {
  it('marks an asset missing after 3 completed runs that did not see it, not after 2', async () => {
    const seen = await inOrg(orgA, (tx) =>
      ingestObservation(tx, orgA, host(`agent:${randomUUID()}`, 'keeps')),
    );
    const gone = await inOrg(orgA, (tx) =>
      ingestObservation(tx, orgA, host(`agent:${randomUUID()}`, 'goes')),
    );
    const manual = await inOrg(orgA, (tx) =>
      ingestObservation(tx, orgA, { ...host(`manual:${randomUUID()}`, 'manual'), source: 'agent' }),
    );
    await sql(`UPDATE assets SET lifecycle = 'manually_managed' WHERE id = $1`, [manual.assetId]);
    const run = async () => {
      const id = await inOrg(orgA, (tx) => startRun(tx, orgA, productA, 'agent'));
      return inOrg(orgA, (tx) => completeRun(tx, orgA, id, [seen.assetId]));
    };
    await run();
    await run();
    let [g] = await sql(`SELECT lifecycle, missed_runs FROM assets WHERE id = $1`, [gone.assetId]);
    expect(g).toMatchObject({ lifecycle: 'discovered', missed_runs: 2 });
    await run();
    [g] = await sql(`SELECT lifecycle FROM assets WHERE id = $1`, [gone.assetId]);
    expect(g!.lifecycle).toBe('missing');
    const [k] = await sql(`SELECT lifecycle, missed_runs FROM assets WHERE id = $1`, [seen.assetId]);
    expect(k).toMatchObject({ missed_runs: 0 });
    const [m] = await sql(`SELECT lifecycle FROM assets WHERE id = $1`, [manual.assetId]);
    expect(m!.lifecycle).toBe('manually_managed');
    const runs = await sql(`SELECT status FROM discovery_runs WHERE product_id = $1`, [productA]);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
  });
});
