import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import {
  createProduct,
  headers,
  login,
  ownerWithOrg,
  signUpAndVerify,
  type Owner,
} from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

let t: TestApp;
const txt: Record<string, string[][]> = {};

beforeAll(async () => {
  t = await createTestApp({
    env: { PCP_AI_FAKE: '1' },
    dns: async (host) =>
      ({ 'shop.example.com': ['93.184.216.34'], 'internal.example.com': ['10.0.0.5'] })[host] ?? [],
    txt: async (name) => {
      const r = txt[name];
      if (!r) throw new Error('ENODATA');
      return r;
    },
  });
});

afterAll(async () => {
  await t?.close();
});

type Body = Record<string, unknown>;
const call = (cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Body) => {
  const { 'content-type': _, ...bare } = headers(cookie);
  return payload === undefined
    ? t.app.inject({ method, url, headers: bare })
    : t.app.inject({ method, url, headers: headers(cookie), payload });
};

async function setup() {
  const owner = await ownerWithOrg(t);
  const productId = await createProduct(t, owner, `P-${randomUUID().slice(0, 6)}`);
  return { owner, productId };
}

async function member(owner: Owner, role: string) {
  const email = await signUpAndVerify(t);
  const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  await sql(
    `INSERT INTO organization_members (id, organization_id, user_id, role, all_products) VALUES ($1, $2, $3, $4, true)`,
    [randomUUID(), owner.orgId, u!.id, role],
  );
  return login(t, email);
}

describe('website monitors (WB-09 UC-09-01/02)', () => {
  it('creates a monitor with TXT instructions, schedules its probe, verifies, lists, and deletes', async () => {
    const { owner, productId } = await setup();
    const res = await call(owner.cookie, 'POST', `/api/v1/products/${productId}/website-monitors`, {
      url: 'https://shop.example.com/',
      intervalSeconds: 60,
    });
    expect(res.statusCode, res.body).toBe(201);
    const m = res.json();
    expect(m).toMatchObject({
      url: 'https://shop.example.com/',
      host: 'shop.example.com',
      status: 'pending_verification',
    });
    expect(m.verification).toEqual({
      record: 'TXT',
      name: 'shop.example.com',
      value: expect.stringMatching(/^pcp-verify=[A-Za-z0-9_-]{20,}$/),
    });
    const [job] = await sql<{ every_seconds: number }>(
      `SELECT every_seconds FROM job_definitions WHERE kind = 'website-probe' AND entity_id = $1`,
      [m.id],
    );
    expect(job).toEqual({ every_seconds: 60 });

    // Not there yet, then the record appears on the parent domain.
    expect(
      (await call(owner.cookie, 'POST', `/api/v1/website-monitors/${m.id}/verify`, {})).json(),
    ).toMatchObject({
      verified: false,
      checkedNames: ['shop.example.com', 'example.com'],
    });
    txt['example.com'] = [[m.verification.value]];
    expect(
      (await call(owner.cookie, 'POST', `/api/v1/website-monitors/${m.id}/verify`, {})).json(),
    ).toMatchObject({
      verified: true,
    });
    const list = (await call(owner.cookie, 'GET', `/api/v1/products/${productId}/website-monitors`)).json();
    expect(list.monitors).toEqual([expect.objectContaining({ id: m.id, status: 'active' })]);
    expect((await call(owner.cookie, 'DELETE', `/api/v1/website-monitors/${m.id}`)).statusCode).toBe(204);
    expect(
      await sql(`SELECT 1 FROM job_definitions WHERE kind = 'website-probe' AND entity_id = $1`, [m.id]),
    ).toHaveLength(0);
    const audit = await sql<{ action: string }>(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'website_monitor.%' ORDER BY created_at`,
      [owner.orgId],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'website_monitor.create',
      'website_monitor.verify',
      'website_monitor.verify',
      'website_monitor.delete',
    ]);
  });

  it('refuses private targets, bad URLs, short intervals, and more than 50 monitors (Review Focus #1)', async () => {
    const { owner, productId } = await setup();
    const url = `/api/v1/products/${productId}/website-monitors`;
    for (const bad of [
      'http://169.254.169.254/',
      'https://10.0.0.5/',
      'https://internal.example.com/',
      'ftp://shop.example.com/',
      'https://nowhere.invalid/',
    ]) {
      expect((await call(owner.cookie, 'POST', url, { url: bad })).statusCode, bad).toBe(400);
    }
    expect(
      (await call(owner.cookie, 'POST', url, { url: 'https://shop.example.com/a', intervalSeconds: 10 }))
        .statusCode,
    ).toBe(400);
    for (let i = 0; i < 50; i++)
      await sql(
        `INSERT INTO website_monitors (organization_id, product_id, url, host, verify_token, updated_at) VALUES ($1, $2, $3, 'shop.example.com', 't', now())`,
        [owner.orgId, productId, `https://shop.example.com/p${i}`],
      );
    const over = await call(owner.cookie, 'POST', url, { url: 'https://shop.example.com/one-more' });
    expect(over.statusCode).toBe(409);
  });

  it('lets viewers read, not manage; other tenants get 404 (Review Focus #5)', async () => {
    const a = await setup();
    const b = await setup();
    const m = (
      await call(a.owner.cookie, 'POST', `/api/v1/products/${a.productId}/website-monitors`, {
        url: 'https://shop.example.com/',
      })
    ).json();
    const viewer = await member(a.owner, 'viewer');
    expect((await call(viewer, 'GET', `/api/v1/products/${a.productId}/website-monitors`)).statusCode).toBe(
      200,
    );
    expect(
      (
        await call(viewer, 'POST', `/api/v1/products/${a.productId}/website-monitors`, {
          url: 'https://shop.example.com/x',
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(b.owner.cookie, 'DELETE', `/api/v1/website-monitors/${m.id}`)).statusCode).toBe(404);
  });

  it('gives the AI assistant website availability with the last result', async () => {
    const { owner, productId } = await setup();
    await sql(
      `INSERT INTO website_monitors (organization_id, product_id, url, host, verify_token, status, verified_at, last_checked_at, last_up, last_status_code, last_total_ms, consecutive_failures, tls_expires_at, updated_at)
       VALUES ($1, $2, 'https://shop.example.com/', 'shop.example.com', 't', 'active', now(), now(), false, 503, 812, 3, now() + interval '40 days', now())`,
      [owner.orgId, productId],
    );
    const conv = (
      await call(owner.cookie, 'POST', `/api/v1/products/${productId}/ai/conversations`, { title: 'x' })
    ).json();
    const res = await call(owner.cookie, 'POST', `/api/v1/ai/conversations/${conv.id}/messages`, {
      content: 'Is the website up?',
    });
    const answer = res.body.split('\n\n').find((b) => b.startsWith('event: answer'))!;
    const data = JSON.parse(answer.split('\n')[1]!.slice(6));
    const site = data.evidence.find((e: Body) => e.tool === 'getWebsiteAvailability');
    expect(site.status).toBe('ok');
    expect(site.data.monitors[0]).toMatchObject({
      url: 'https://shop.example.com/',
      up: false,
      statusCode: 503,
      consecutiveFailures: 3,
    });
    expect(data.missing).not.toContain('Website availability: source not connected');
  });
});
