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

beforeAll(async () => {
  t = await createTestApp({ env: { PCP_AI_FAKE: '1' } });
});

afterAll(async () => {
  await t?.close();
});

type Body = Record<string, unknown>;
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Body) => {
  const { 'content-type': _, ...bare } = headers(cookie);
  return payload === undefined
    ? t.app.inject({ method, url, headers: bare })
    : t.app.inject({ method, url, headers: headers(cookie), payload });
};

/** Parses an SSE body into events. */
const events = (body: string) =>
  body
    .split('\n\n')
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1],
      data: /^data: (.*)$/m.exec(block)?.[1],
    }))
    .filter((e) => e.event)
    .map((e) => ({ event: e.event!, data: e.data ? (JSON.parse(e.data) as Body) : {} }));

async function setup() {
  const owner = await ownerWithOrg(t);
  const productId = await createProduct(t, owner, `P-${randomUUID().slice(0, 6)}`);
  return { owner, productId };
}

async function member(owner: Owner, role: string, productIds: string[] | 'all') {
  const email = await signUpAndVerify(t);
  const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  await sql(
    `INSERT INTO organization_members (id, organization_id, user_id, role, all_products, product_ids)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[])`,
    [randomUUID(), owner.orgId, u!.id, role, productIds === 'all', productIds === 'all' ? [] : productIds],
  );
  return login(t, email);
}

async function ask(cookie: string, productId: string, content: string) {
  const conv = await call(cookie, 'POST', `/api/v1/products/${productId}/ai/conversations`, {
    title: content,
  });
  expect(conv.statusCode, conv.body).toBe(201);
  const res = await call(cookie, 'POST', `/api/v1/ai/conversations/${conv.json().id}/messages`, { content });
  return { conversationId: conv.json().id as string, res, events: events(res.body) };
}

describe('AI assistant (WB-14 UC-14-01)', () => {
  it('streams tool steps and a cited answer, and stores the conversation', async () => {
    const { owner, productId } = await setup();
    const {
      conversationId,
      res,
      events: ev,
    } = await ask(owner.cookie, productId, 'Why was it slow yesterday?');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // Each tool reports when it starts and when it finishes.
    expect(ev.map((e) => e.event)).toEqual([
      'started',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'answer',
      'done',
    ]);
    const answer = ev.find((e) => e.event === 'answer')!.data;
    expect(answer).toMatchObject({ validation: 'verified' });
    expect(String(answer.text)).toContain('[E1]');
    expect(answer.missing).toEqual(expect.arrayContaining(['Deployments: source not connected']));

    const conv = (await call(owner.cookie, 'GET', `/api/v1/ai/conversations/${conversationId}`)).json();
    expect(conv.messages.map((m: Body) => m.role)).toEqual(['user', 'assistant']);
    expect(conv.messages[1]).toMatchObject({ validation: 'verified' });
    expect(conv.messages[1].evidence.map((e: Body) => e.tool)).toEqual([
      'getIncidents',
      'getInfrastructureMetrics',
      'getDeployments',
    ]);
    const [run] = await sql<{ status: string; tool_calls: number; provider: string }>(
      `SELECT status, tool_calls, provider FROM ai_runs WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(run).toEqual({ status: 'completed', tool_calls: 3, provider: 'scripted' });
    const list = (await call(owner.cookie, 'GET', `/api/v1/products/${productId}/ai/conversations`)).json();
    expect(list.conversations.map((c: Body) => c.id)).toEqual([conversationId]);
  });

  it("returns not_found for another tenant's asset and audits the denial (TC-14-01)", async () => {
    const a = await setup();
    const b = await setup();
    const foreign = randomUUID();
    await sql(
      `INSERT INTO assets (id, organization_id, asset_type, name, source, identity_key) VALUES ($1, $2, 'host', 'b-secret-host', 'agent', $3)`,
      [foreign, b.owner.orgId, `agent:${foreign}`],
    );
    const { events: ev } = await ask(a.owner.cookie, a.productId, `Tell me about asset ${foreign}`);
    const tool = ev.find((e) => e.event === 'tool' && e.data.status !== 'running')!.data;
    expect(tool).toMatchObject({ tool: 'getAssetDetails', status: 'denied' });
    expect(JSON.stringify(ev)).not.toContain('b-secret-host');
    const audit = await sql(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action = 'ai.tool_denied'`,
      [a.owner.orgId],
    );
    expect(audit).toHaveLength(1);
  });

  it('keeps tools inside the conversation product and the member scope (Review Focus #4)', async () => {
    const { owner, productId } = await setup();
    const hidden = await createProduct(t, owner, `Hidden-${randomUUID().slice(0, 6)}`);
    const scoped = await member(owner, 'analyst', [productId]);
    const { events: ev } = await ask(scoped, productId, 'Which products can you see?');
    const listed = JSON.stringify(ev);
    expect(listed).not.toContain(hidden);
    // The scoped member cannot open a conversation in the other product.
    expect(
      (await call(scoped, 'POST', `/api/v1/products/${hidden}/ai/conversations`, { title: 'x' })).statusCode,
    ).toBe(404);
  });

  it('is off for viewers (no ai.use) and when the organization disables AI (TC-14-06)', async () => {
    const { owner, productId } = await setup();
    const viewer = await member(owner, 'viewer', 'all');
    expect(
      (await call(viewer, 'POST', `/api/v1/products/${productId}/ai/conversations`, { title: 'x' }))
        .statusCode,
    ).toBe(404);

    const settings = await call(owner.cookie, 'GET', `/api/v1/organizations/${owner.orgId}/settings/ai`);
    expect(settings.json()).toMatchObject({ disabled: false, available: true, provider: 'scripted' });
    expect(
      (
        await call(owner.cookie, 'PATCH', `/api/v1/organizations/${owner.orgId}/settings/ai`, {
          disabled: true,
        })
      ).statusCode,
    ).toBe(200);
    const blocked = await call(owner.cookie, 'POST', `/api/v1/products/${productId}/ai/conversations`, {
      title: 'x',
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('ai_disabled');
    // Dashboards keep working.
    expect((await call(owner.cookie, 'GET', `/api/v1/products/${productId}/incidents`)).statusCode).toBe(200);
    const audit = await sql(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action = 'ai.settings_update'`,
      [owner.orgId],
    );
    expect(audit).toHaveLength(1);
  });
});
