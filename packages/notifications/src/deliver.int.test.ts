import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import { startPostgres, type TestDatabase } from '@pcp/database/testing';
import { encryptSecret, serializeSecret } from '@pcp/secrets';
import type { TenantContext } from '@pcp/shared-contracts';
import { processDelivery, type DeliveryDeps } from './deliver.js';
import { verify } from './sign.js';

let db: TestDatabase;
let prisma: PrismaClient;
let server: Server;
let port = 0;
let status = 200;
const received: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: string }> =
  [];
const mails: Array<{ to: string[]; subject: string; text: string }> = [];

const key = randomBytes(32);
const kek = { version: 1, key };
const ring = new Map([[1, key]]);
const org = randomUUID();
const product = randomUUID();

const ctx: TenantContext = {
  organizationId: org,
  actor: { kind: 'system', jobId: 'deliver' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: 'r',
};

const deps = (over: Partial<DeliveryDeps> = {}): DeliveryDeps => ({
  keyRing: ring,
  appOrigin: 'https://monitor.example.com',
  now: () => new Date('2026-10-23T10:00:00Z'),
  sendMail: async (m) => {
    mails.push(m);
  },
  destination: { allowPrivate: true, allowlist: [`127.0.0.1:${port}`] },
  ...over,
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

async function channel(
  kind: 'email' | 'slack' | 'webhook',
  target?: { url: string; signingSecret?: string },
) {
  const id = randomUUID();
  const secret = target
    ? serializeSecret(encryptSecret(Buffer.from(JSON.stringify(target)), `notification-channel:${id}`, kek))
    : null;
  await sql(
    `INSERT INTO notification_channels (id, organization_id, name, kind, config, secret, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      id,
      org,
      `${kind} channel`,
      kind,
      kind === 'email' ? { recipients: ['ops@example.com'] } : { target: '127.0.0.1' },
      secret,
    ],
  );
  return id;
}

let incidentId = '';
async function delivery(channelId: string, event = 'opened') {
  const id = randomUUID();
  await sql(
    `INSERT INTO notification_deliveries (id, organization_id, channel_id, incident_id, event) VALUES ($1, $2, $3, $4, $5)`,
    [id, org, channelId, event === 'test' ? null : incidentId, event],
  );
  return id;
}

const row = async (id: string) =>
  (await sql(`SELECT status, attempts, last_error FROM notification_deliveries WHERE id = $1`, [id]))[0];
const channelRow = async (id: string) =>
  (await sql(`SELECT status, consecutive_failures FROM notification_channels WHERE id = $1`, [id]))[0];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.statusCode = status;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  port = typeof a === 'object' && a ? a.port : 0;
  db = await startPostgres();
  prisma = createPrismaClient(db.appUrl);
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'Acme')`, [org]);
  await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'Shop')`, [product, org]);
  const rule = randomUUID();
  await sql(
    `INSERT INTO alert_rules (id, organization_id, product_id, name, template, params, severity, updated_at)
     VALUES ($1, $2, $3, 'Server CPU high', 'host_cpu_high', '{}', 'critical', now())`,
    [rule, org, product],
  );
  incidentId = randomUUID();
  await sql(
    `INSERT INTO alert_incidents (id, organization_id, product_id, rule_id, fingerprint, title, severity, summary, started_at)
     VALUES ($1, $2, $3, $4, 'fp', 'Server CPU high on vps-1', 'critical', 'Server CPU high on vps-1. Latest value 97.3.', now())`,
    [incidentId, org, product, rule],
  );
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.stop();
  await new Promise((r) => server?.close(r));
});

describe('processDelivery (UC-13-05/09/10)', () => {
  it('emails the recipients with the rendered incident', async () => {
    const id = await delivery(await channel('email'));
    await processDelivery(prisma, ctx, id, false, deps());
    expect(await row(id)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(mails.at(-1)).toMatchObject({
      to: ['ops@example.com'],
      subject: '[CRITICAL] Server CPU high on vps-1 — opened',
    });
    expect(mails.at(-1)!.text).toContain(
      `https://monitor.example.com/orgs/${org}/products/${product}/incidents/${incidentId}`,
    );
  });

  it('posts a signed webhook that the documented algorithm verifies (TC-13-08)', async () => {
    const id = await delivery(
      await channel('webhook', { url: `http://127.0.0.1:${port}/hook`, signingSecret: 'sekret' }),
    );
    await processDelivery(prisma, ctx, id, false, deps());
    const req = received.at(-1)!;
    expect(req.url).toBe('/hook');
    expect(JSON.parse(req.body)).toMatchObject({ type: 'incident.opened', incident: { id: incidentId } });
    const header = String(req.headers['x-pcp-signature']);
    expect(verify('sekret', req.body, header, Date.parse('2026-10-23T10:01:00Z') / 1000)).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'sent' });
  });

  it('posts Slack text', async () => {
    const id = await delivery(await channel('slack', { url: `http://127.0.0.1:${port}/slack` }));
    await processDelivery(prisma, ctx, id, false, deps());
    expect(JSON.parse(received.at(-1)!.body).text).toContain('*[CRITICAL] Server CPU high on vps-1*');
  });

  it('retries failures, dead-letters the last one, and marks the channel broken after 3 dead deliveries', async () => {
    status = 500;
    try {
      const ch = await channel('webhook', { url: `http://127.0.0.1:${port}/down`, signingSecret: 's' });
      const first = await delivery(ch);
      await expect(processDelivery(prisma, ctx, first, false, deps())).rejects.toThrow(/500/);
      expect(await row(first)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(await channelRow(ch)).toEqual({ status: 'active', consecutive_failures: 0 });
      for (let i = 0; i < 3; i++) {
        const d = await delivery(ch);
        await expect(processDelivery(prisma, ctx, d, true, deps())).rejects.toThrow();
        expect((await row(d)).status).toBe('dead');
      }
      expect(await channelRow(ch)).toEqual({ status: 'broken', consecutive_failures: 3 });
      status = 200;
      // A test message that goes through brings the channel back.
      const test = await delivery(ch, 'test');
      await processDelivery(prisma, ctx, test, false, deps());
      expect(await channelRow(ch)).toEqual({ status: 'active', consecutive_failures: 0 });
      expect(JSON.parse(received.at(-1)!.body)).toEqual({
        type: 'test',
        link: 'https://monitor.example.com',
      });
    } finally {
      status = 200;
    }
  });

  it('refuses a private destination without contacting it (Review Focus #3)', async () => {
    const before = received.length;
    const id = await delivery(
      await channel('webhook', { url: `http://127.0.0.1:${port}/private`, signingSecret: 's' }),
    );
    await expect(
      processDelivery(prisma, ctx, id, true, deps({ destination: { allowPrivate: false } })),
    ).rejects.toThrow(/private address/);
    expect(received.length).toBe(before);
    expect((await row(id)).last_error).toMatch(/private address/);
  });

  it('skips a delivery whose channel was deleted', async () => {
    const ch = await channel('email');
    const id = await delivery(ch);
    await sql(`DELETE FROM notification_channels WHERE id = $1`, [ch]);
    expect(await processDelivery(prisma, ctx, id, false, deps())).toEqual({
      skipped: 'delivery or channel gone',
    });
  });
});
