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

  it('answers with deployments from a connected GitHub (M7 change events)', async () => {
    const { owner, productId } = await setup();
    const conn = randomUUID();
    await sql(
      `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, updated_at)
       VALUES ($1, $2, 'github', 'GitHub', 'connected', 'cloud', now())`,
      [conn, owner.orgId],
    );
    await sql(
      `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, '101', 'github_repository', 'acme/shop', $3)`,
      [owner.orgId, conn, productId],
    );
    await sql(
      `INSERT INTO change_events (organization_id, connection_id, provider, kind, title, occurred_at, external_id)
       VALUES ($1, $2, 'github', 'deployment', 'Deployed main to production (acme/shop)', now() - interval '2 hours', '55:success')`,
      [owner.orgId, conn],
    );
    const { events: ev } = await ask(owner.cookie, productId, 'Why was FireMaps slow yesterday?');
    const answer = ev.find((e) => e.event === 'answer')!.data;
    const deployments = (answer.evidence as Body[]).find((e) => e.tool === 'getDeployments')!;
    expect(deployments.status).toBe('ok');
    expect((deployments.data as Body).changes).toEqual([
      expect.objectContaining({ kind: 'deployment', title: 'Deployed main to production (acme/shop)' }),
    ]);
    expect(answer.missing).not.toContain('Deployments: source not connected');
  });

  it('answers traffic questions from GA4 daily values (M13b)', async () => {
    const { owner, productId } = await setup();
    const conn = randomUUID();
    await sql(
      `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, granted_scopes, updated_at)
       VALUES ($1, $2, 'google', 'Google', 'connected', 'cloud', ARRAY['https://www.googleapis.com/auth/analytics.readonly'], now())`,
      [conn, owner.orgId],
    );
    await sql(
      `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, 'properties/1', 'google_ga4_property', 'FireMaps web', $3)`,
      [owner.orgId, conn, productId],
    );
    for (const [offset, users, completeness] of [
      [1, 100, 'complete'],
      [0, 40, 'partial'],
    ] as const)
      await sql(
        `INSERT INTO metric_aggregates (organization_id, connection_id, resource_type, external_id, metric, day, value, completeness)
         VALUES ($1, $2, 'google_ga4_property', 'properties/1', 'activeUsers', (now() - make_interval(days => $3))::date, $4, $5)`,
        [owner.orgId, conn, offset, users, completeness],
      );
    const { events: ev } = await ask(owner.cookie, productId, 'How many users visited FireMaps this week?');
    const answer = ev.find((e) => e.event === 'answer')!.data;
    const analytics = (answer.evidence as Body[]).find((e) => e.tool === 'getAnalyticsReport')!;
    expect(analytics.status).toBe('ok');
    expect((analytics.data as Body).resources).toEqual([
      expect.objectContaining({
        name: 'FireMaps web',
        source: 'GA4',
        partialDays: 1,
        totals: expect.objectContaining({ 'Active users (daily average)': 70 }),
      }),
    ]);
    expect(answer.missing).not.toContain('Analytics: source not connected');
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

  it("keeps a member's conversation private from other members", async () => {
    const { owner, productId } = await setup();
    const { conversationId } = await ask(owner.cookie, productId, 'Private question');
    const other = await member(owner, 'analyst', 'all');
    expect((await call(other, 'GET', `/api/v1/ai/conversations/${conversationId}`)).statusCode).toBe(404);
    expect(
      (await call(other, 'POST', `/api/v1/ai/conversations/${conversationId}/messages`, { content: 'hi' }))
        .statusCode,
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
