import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
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

const TOKEN = 'internal-token-for-alert-tests-0123456789';
const rulesDir = mkdtempSync(join(tmpdir(), 'pcp-alert-rules-'));
let reloads = 0;
let vmalert: Server;
let t: TestApp;

beforeAll(async () => {
  vmalert = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/-/reload') reloads++;
    res.end('ok');
  });
  await new Promise<void>((r) => vmalert.listen(0, '127.0.0.1', r));
  const address = vmalert.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  t = await createTestApp({
    env: { INTERNAL_TOKEN: TOKEN, ALERT_RULES_DIR: rulesDir, VMALERT_URL: `http://127.0.0.1:${port}` },
    dns: async (host) =>
      host === 'hooks.example.com' ? ['93.184.216.34'] : host === 'internal.example.com' ? ['10.0.0.5'] : [],
  });
});

afterAll(async () => {
  await t?.close();
  await new Promise((r) => vmalert?.close(r));
});

type Body = Record<string, unknown>;
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Body) => {
  const { 'content-type': _, ...bare } = headers(cookie);
  return payload === undefined
    ? t.app.inject({ method, url, headers: bare })
    : t.app.inject({ method, url, headers: headers(cookie), payload });
};
const receive = (alerts: Body[], token: string | null = TOKEN) =>
  t.app.inject({
    method: 'POST',
    url: '/internal/alertmanager/api/v2/alerts',
    headers: token ? { 'x-internal-token': token } : {},
    payload: alerts,
  });
const tenantFile = (orgId: string) => parse(readFileSync(join(rulesDir, `tenant-${orgId}.yaml`), 'utf8'));

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

async function setup() {
  const owner = await ownerWithOrg(t);
  const productId = await createProduct(t, owner, `P-${randomUUID().slice(0, 6)}`);
  return { owner, productId };
}

const alert = (orgId: string, ruleId: string, over: Body = {}) => ({
  labels: {
    alertname: 'host_cpu_high-x',
    tenant_id: orgId,
    rule_id: ruleId,
    severity: 'warning',
    agent_id: 'agent-9',
  },
  annotations: { summary: 'CPU high', value: '97.1' },
  startsAt: new Date().toISOString(),
  endsAt: '0001-01-01T00:00:00Z',
  generatorURL: 'http://vmalert/x',
  ...over,
});

describe('alert rules (WB-13 UC-13-01)', () => {
  it('creates, compiles, reloads, disables, and deletes', async () => {
    const { owner, productId } = await setup();
    const before = reloads;
    const created = await call(owner.cookie, 'POST', `/api/v1/products/${productId}/alert-rules`, {
      template: 'host_cpu_high',
      params: { threshold: 85 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const rule = created.json();
    expect(rule).toMatchObject({
      template: 'host_cpu_high',
      name: 'Server CPU high',
      params: { threshold: 85, forMinutes: 10 },
      severity: 'warning',
      enabled: true,
    });
    const file = tenantFile(owner.orgId);
    expect(file.groups[0].params.extra_label).toEqual([`tenant_id=${owner.orgId}`]);
    expect(file.groups[0].params.extra_filters).toEqual([`{product_id="${productId}"}`]);
    expect(file.groups[0].rules[0].expr).toMatch(/> 85$/);
    expect(reloads).toBe(before + 1);
    const list = await call(owner.cookie, 'GET', `/api/v1/products/${productId}/alert-rules`);
    expect(list.json().rules.map((r: Body) => r.id)).toEqual([rule.id]);
    expect(list.json().templates.length).toBeGreaterThanOrEqual(6);

    const off = await call(owner.cookie, 'PATCH', `/api/v1/alert-rules/${rule.id}`, { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(tenantFile(owner.orgId)).toEqual({ groups: [] });
    expect((await call(owner.cookie, 'DELETE', `/api/v1/alert-rules/${rule.id}`)).statusCode).toBe(204);
    const [audit] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action LIKE 'alert_rule.%'`,
      [owner.orgId],
    );
    expect(audit!.n).toBe(3);
  });

  it('refuses unknown templates and parameters, and members without incident.manage', async () => {
    const { owner, productId } = await setup();
    const url = `/api/v1/products/${productId}/alert-rules`;
    expect((await call(owner.cookie, 'POST', url, { template: 'free_promql' })).statusCode).toBe(400);
    expect(
      (await call(owner.cookie, 'POST', url, { template: 'host_cpu_high', params: { promql: 'up' } }))
        .statusCode,
    ).toBe(400);
    const viewer = await member(owner, 'viewer', 'all');
    expect((await call(viewer, 'POST', url, { template: 'host_cpu_high' })).statusCode).toBe(404);
    expect((await call(viewer, 'GET', url)).statusCode).toBe(200);
  });

  it('adds the recommended rules once and schedules the worker tick', async () => {
    const { owner, productId } = await setup();
    const url = `/api/v1/products/${productId}/alert-rules/recommended`;
    expect((await call(owner.cookie, 'POST', url, {})).statusCode).toBe(201);
    expect((await call(owner.cookie, 'POST', url, {})).statusCode).toBe(201);
    const rules = (await call(owner.cookie, 'GET', `/api/v1/products/${productId}/alert-rules`)).json()
      .rules as Body[];
    expect(rules.map((r) => r.template).sort()).toEqual(
      [
        'agent_heartbeat_missing',
        'host_cpu_high',
        'host_disk_full',
        'host_memory_high',
        'log_error_spike',
      ].sort(),
    );
    const [tick] = await sql<{ every_seconds: number; enabled: boolean }>(
      `SELECT every_seconds, enabled FROM job_definitions WHERE organization_id = $1 AND kind = 'alert-tick'`,
      [owner.orgId],
    );
    expect(tick).toEqual({ every_seconds: 60, enabled: true });
  });
});

describe('alert receiver (UC-13-02, BR-13-08)', () => {
  it('needs the internal token', async () => {
    expect((await receive([], null)).statusCode).toBe(401);
    expect((await receive([], 'wrong-token-wrong-token-wrong')).statusCode).toBe(401);
  });

  it('opens an incident, notifies the channels, and drops a forged tenant (Review Focus #1)', async () => {
    const a = await setup();
    const b = await setup();
    const ruleA = (
      await call(a.owner.cookie, 'POST', `/api/v1/products/${a.productId}/alert-rules`, {
        template: 'host_cpu_high',
      })
    ).json();
    const channel = await call(
      a.owner.cookie,
      'POST',
      `/api/v1/organizations/${a.owner.orgId}/notification-channels`,
      {
        name: 'Ops',
        kind: 'email',
        recipients: ['ops@example.com'],
      },
    );
    expect(channel.statusCode, channel.body).toBe(201);

    // B's tenant label with A's rule: dropped, no incident anywhere.
    expect((await receive([alert(b.owner.orgId, ruleA.id)])).statusCode).toBe(200);
    expect((await sql(`SELECT 1 FROM alert_incidents WHERE rule_id = $1`, [ruleA.id])).length).toBe(0);

    expect((await receive([alert(a.owner.orgId, ruleA.id)])).statusCode).toBe(200);
    const list = await call(a.owner.cookie, 'GET', `/api/v1/products/${a.productId}/incidents`);
    expect(list.statusCode).toBe(200);
    const [incident] = list.json().incidents;
    expect(incident).toMatchObject({
      title: 'Server CPU high on agent-9',
      status: 'open',
      severity: 'warning',
    });
    const deliveries = await sql<{ status: string; event: string }>(
      `SELECT status, event FROM notification_deliveries WHERE incident_id = $1`,
      [incident.id],
    );
    expect(deliveries).toEqual([{ status: 'pending', event: 'opened' }]);
    expect((await call(b.owner.cookie, 'GET', `/api/v1/incidents/${incident.id}`)).statusCode).toBe(404);

    // Resolved by vmalert.
    await receive([alert(a.owner.orgId, ruleA.id, { endsAt: new Date().toISOString() })]);
    const detail = (await call(a.owner.cookie, 'GET', `/api/v1/incidents/${incident.id}`)).json();
    expect(detail.incident.status).toBe('resolved');
  });
});

describe('incidents (UC-13-06/08/11)', () => {
  it('acknowledges, resolves with a note, records a postmortem, and hides other products', async () => {
    const { owner, productId } = await setup();
    const otherProduct = await createProduct(t, owner, `Q-${randomUUID().slice(0, 6)}`);
    const rule = (
      await call(owner.cookie, 'POST', `/api/v1/products/${productId}/alert-rules`, {
        template: 'host_disk_full',
      })
    ).json();
    await receive([
      alert(owner.orgId, rule.id, { labels: { ...alert(owner.orgId, rule.id).labels, mountpoint: '/' } }),
    ]);
    const [incident] = (await call(owner.cookie, 'GET', `/api/v1/products/${productId}/incidents`)).json()
      .incidents;
    expect(incident.severity).toBe('critical');

    const outsider = await member(owner, 'operator', [otherProduct]);
    expect((await call(outsider, 'GET', `/api/v1/incidents/${incident.id}`)).statusCode).toBe(404);
    const viewer = await member(owner, 'viewer', 'all');
    expect((await call(viewer, 'GET', `/api/v1/incidents/${incident.id}`)).statusCode).toBe(200);
    expect((await call(viewer, 'POST', `/api/v1/incidents/${incident.id}/acknowledge`, {})).statusCode).toBe(
      404,
    );

    expect(
      (await call(owner.cookie, 'POST', `/api/v1/incidents/${incident.id}/acknowledge`, {})).statusCode,
    ).toBe(200);
    expect(
      (await call(owner.cookie, 'POST', `/api/v1/incidents/${incident.id}/acknowledge`, {})).statusCode,
    ).toBe(409);
    const resolved = await call(owner.cookie, 'POST', `/api/v1/incidents/${incident.id}/resolve`, {
      note: 'Cleaned /var/log',
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const pm = await call(owner.cookie, 'PATCH', `/api/v1/incidents/${incident.id}/postmortem`, {
      summary: 'Logs filled the disk',
      causeCategory: 'capacity',
      followUps: ['Rotate logs daily'],
    });
    expect(pm.statusCode, pm.body).toBe(200);
    const detail = (await call(owner.cookie, 'GET', `/api/v1/incidents/${incident.id}`)).json();
    expect(detail.incident).toMatchObject({ status: 'resolved', resolutionNote: 'Cleaned /var/log' });
    expect(detail.incident.postmortem).toMatchObject({ causeCategory: 'capacity' });
    expect(detail.events.map((e: Body) => e.kind)).toEqual(
      expect.arrayContaining(['fired', 'acknowledged', 'resolved']),
    );
    expect(detail.sourceLinks.length).toBeGreaterThanOrEqual(1);
    const actions = await sql<{ action: string }>(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'incident.%' ORDER BY created_at`,
      [owner.orgId],
    );
    expect(actions.map((a) => a.action)).toEqual([
      'incident.acknowledge',
      'incident.resolve',
      'incident.postmortem',
    ]);
  });
});

describe('notification channels (UC-13-09, Review Focus #3)', () => {
  it('stores webhook secrets encrypted, shows the signing secret once, and refuses private targets', async () => {
    const { owner } = await setup();
    const url = `/api/v1/organizations/${owner.orgId}/notification-channels`;
    const hook = await call(owner.cookie, 'POST', url, {
      name: 'Ops hook',
      kind: 'webhook',
      url: 'https://hooks.example.com/pcp',
    });
    expect(hook.statusCode, hook.body).toBe(201);
    expect(hook.json().signingSecret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const slack = await call(owner.cookie, 'POST', url, {
      name: 'Slack',
      kind: 'slack',
      url: 'https://hooks.example.com/services/T/B/x',
    });
    expect(slack.statusCode, slack.body).toBe(201);
    const listed = (await call(owner.cookie, 'GET', url)).json().channels as Body[];
    expect(JSON.stringify(listed)).not.toContain('services/T/B/x');
    expect(JSON.stringify(listed)).not.toContain(hook.json().signingSecret);
    expect(listed.find((c) => c.kind === 'webhook')).toMatchObject({
      target: 'hooks.example.com',
      status: 'active',
    });
    const [row] = await sql<{ secret: string }>(`SELECT secret FROM notification_channels WHERE id = $1`, [
      hook.json().id,
    ]);
    expect(row!.secret).not.toContain('hooks.example.com');

    for (const bad of [
      'http://hooks.example.com/x',
      'https://169.254.169.254/latest',
      'https://10.0.0.5/hook',
      'https://internal.example.com/hook',
    ]) {
      const res = await call(owner.cookie, 'POST', url, { name: 'Bad', kind: 'webhook', url: bad });
      expect(res.statusCode, bad).toBe(400);
    }
    expect(
      (
        await call(owner.cookie, 'POST', url, {
          name: 'Many',
          kind: 'email',
          recipients: Array(11).fill('a@b.co'),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('queues a test delivery, and only admins and owners manage channels', async () => {
    const { owner } = await setup();
    const url = `/api/v1/organizations/${owner.orgId}/notification-channels`;
    const ch = (
      await call(owner.cookie, 'POST', url, { name: 'Ops', kind: 'email', recipients: ['ops@example.com'] })
    ).json();
    expect(
      (await call(owner.cookie, 'POST', `/api/v1/notification-channels/${ch.id}/test`, {})).statusCode,
    ).toBe(202);
    const [d] = await sql<{ event: string; status: string }>(
      `SELECT event, status FROM notification_deliveries WHERE channel_id = $1`,
      [ch.id],
    );
    expect(d).toEqual({ event: 'test', status: 'pending' });
    const operator = await member(owner, 'operator', 'all');
    expect(
      (await call(operator, 'POST', url, { name: 'X', kind: 'email', recipients: ['x@example.com'] }))
        .statusCode,
    ).toBe(404);
  });
});
