import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { startPostgres, type TestDatabase } from '@pcp/test-support';
import { websiteProbeHandler, type WebsiteDeps } from './website-handler.js';

let db: TestDatabase;
let prisma: PrismaClient;
let target: Server;
let vm: Server;
let targetPort = 0;
let vmPort = 0;
let targetStatus = 200;
const imported: string[] = [];
const org = randomUUID();
const product = randomUUID();
const T0 = new Date('2026-10-23T10:00:00Z');

async function sql(text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.superuserUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

const listen = (s: Server) =>
  new Promise<number>((r) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      r(typeof a === 'object' && a ? a.port : 0);
    }),
  );

const ctx: TenantContext = {
  organizationId: org,
  actor: { kind: 'system', jobId: 'probe' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: 'r',
};

let txt: Record<string, string[][]> = {};
const deps = (now = T0): WebsiteDeps => ({
  prisma,
  now: () => now,
  resolveTxt: async (name) => {
    const r = txt[name];
    if (!r) throw new Error('ENODATA');
    return r;
  },
  destination: { allowPrivate: true, allowlist: [`127.0.0.1:${targetPort}`] },
  vmImportUrl: `http://127.0.0.1:${vmPort}`,
});

async function monitor(over: Record<string, unknown> = {}) {
  const id = randomUUID();
  const m = { status: 'pending_verification', verified_at: null, created_at: T0, ...over };
  await sql(
    `INSERT INTO website_monitors (id, organization_id, product_id, url, host, verify_token, status, verified_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, '127.0.0.1', 'tok-1', $5, $6, $7, now())`,
    [
      id,
      org,
      product,
      `http://127.0.0.1:${targetPort}/health?m=${id}`,
      m.status,
      m.verified_at,
      m.created_at,
    ],
  );
  return id;
}
const row = async (id: string) => (await sql(`SELECT * FROM website_monitors WHERE id = $1`, [id]))[0];

beforeAll(async () => {
  target = createServer((_req, res) => res.writeHead(targetStatus).end('ok'));
  vm = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/v1/import/prometheus') imported.push(body);
      res.end();
    });
  });
  [targetPort, vmPort] = await Promise.all([listen(target), listen(vm)]);
  db = await startPostgres();
  prisma = createPrismaClient(db.appUrl);
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'Web Co')`, [org]);
  await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'Shop')`, [product, org]);
});

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.stop();
  await Promise.all([new Promise((r) => target.close(r)), new Promise((r) => vm.close(r))]);
});

describe('website-probe job (WB-09)', () => {
  it('does not probe an unverified domain (TC-09-01)', async () => {
    const id = await monitor();
    const before = imported.length;
    expect(await websiteProbeHandler(deps())(ctx, id)).toEqual({ skipped: 'domain not verified' });
    expect(imported.length).toBe(before);
    expect((await row(id)).verification_checked_at).not.toBeNull();
  });

  it('starts probing once the TXT record appears, and writes labelled samples', async () => {
    const id = await monitor();
    txt = { '127.0.0.1': [['pcp-verify=tok-1']] };
    try {
      const out = await websiteProbeHandler(deps())(ctx, id);
      expect(out).toMatchObject({ up: true, statusCode: 200 });
    } finally {
      txt = {};
    }
    const r = await row(id);
    expect(r).toMatchObject({
      status: 'active',
      last_up: true,
      last_status_code: 200,
      consecutive_failures: 0,
    });
    expect(r.verified_at).not.toBeNull();
    const sample = imported.at(-1)!;
    expect(sample).toContain(`website_up{tenant_id="${org}",product_id="${product}",monitor_id="${id}"`);
    expect(sample).toMatch(/website_response_seconds\{[^}]+\} [\d.]+ \d+/);
  });

  it('counts consecutive failures and resets on recovery (TC-09-03)', async () => {
    const id = await monitor({ status: 'active', verified_at: T0 });
    targetStatus = 503;
    try {
      await websiteProbeHandler(deps())(ctx, id);
      await websiteProbeHandler(deps())(ctx, id);
    } finally {
      targetStatus = 200;
    }
    expect(await row(id)).toMatchObject({ last_up: false, last_status_code: 503, consecutive_failures: 2 });
    expect(imported.at(-1)).toMatch(/website_up\{[^}]+\} 0 /);
    await websiteProbeHandler(deps())(ctx, id);
    expect(await row(id)).toMatchObject({ last_up: true, consecutive_failures: 0 });
  });

  it('pauses a monitor whose domain stays unverified for 24 hours', async () => {
    const id = await monitor({ created_at: new Date(T0.getTime() - 25 * 3600_000) });
    expect(await websiteProbeHandler(deps())(ctx, id)).toEqual({ skipped: 'verification timed out' });
    expect(await row(id)).toMatchObject({
      status: 'paused',
      paused_reason: 'Domain verification timed out after 24 hours',
    });
  });

  it('re-verifies every 30 days and pauses when the record is gone', async () => {
    const id = await monitor({ status: 'active', verified_at: new Date(T0.getTime() - 31 * 86400_000) });
    expect(await websiteProbeHandler(deps())(ctx, id)).toEqual({ skipped: 'verification failed' });
    expect(await row(id)).toMatchObject({ status: 'paused' });
    expect((await row(id)).paused_reason).toMatch(/TXT record pcp-verify=tok-1 was not found/);
  });

  it('skips a deleted monitor', async () => {
    expect(await websiteProbeHandler(deps())(ctx, randomUUID())).toEqual({ skipped: 'monitor not found' });
  });
});
