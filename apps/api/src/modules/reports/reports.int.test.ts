import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createQueues, type Queues } from '@pcp/jobs';
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
let queues: Queues;
const NOW = new Date('2026-10-25T12:00:00Z');

beforeAll(async () => {
  t = await createTestApp({ clock: () => NOW });
  queues = createQueues(inject('redisUrl'));
});

afterAll(async () => {
  await queues?.close();
  await t?.close();
});

type Body = Record<string, unknown>;
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Body) => {
  const { 'content-type': _, ...bare } = headers(cookie);
  return payload === undefined
    ? t.app.inject({ method, url, headers: bare })
    : t.app.inject({ method, url, headers: headers(cookie), payload });
};

async function setup() {
  const owner = await ownerWithOrg(t);
  const productId = await createProduct(t, owner, `P-${randomUUID().slice(0, 6)}`);
  const channelId = randomUUID();
  await sql(
    `INSERT INTO notification_channels (id, organization_id, name, kind, config, updated_at)
     VALUES ($1, $2, 'Ops', 'email', '{"recipients":["ops@example.com"]}', now())`,
    [channelId, owner.orgId],
  );
  return { owner, productId, channelId };
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

const daily = (channelId: string, over: Body = {}) => ({
  name: 'Daily summary',
  timezone: 'Europe/Berlin',
  localTime: '08:00',
  channelIds: [channelId],
  recipients: ['cto@example.com'],
  ...over,
});

const create = (cookie: string, productId: string, body: Body) =>
  call(cookie, 'POST', '/api/v1/report-schedules', { productId, ...body });

const queued = async () =>
  (await queues.get('report-generate').getJobs(['waiting', 'delayed'])).map((j) => j.id);

async function seedReport(orgId: string, productId: string, scheduleId: string | null) {
  const id = randomUUID();
  const snapshot = {
    window: { timezone: 'Europe/Berlin', localDate: '2026-10-24', start: 'x', end: 'y', hours: 24 },
    sections: [
      {
        id: 'S5',
        key: 'analytics',
        title: 'User analytics',
        status: 'missing',
        data: null,
        reason: 'Google Analytics not connected (M13b)',
      },
    ],
    anomalies: [],
    actions: [],
    coverage: [],
  };
  await sql(
    `INSERT INTO generated_reports (id, organization_id, product_id, schedule_id, local_date, version, window_start, window_end, timezone, snapshot, narrative_status)
     VALUES ($1, $2, $3, $4, '2026-10-24', 1, '2026-10-23T22:00:00Z', '2026-10-24T22:00:00Z', 'Europe/Berlin', $5, 'deferred')`,
    [id, orgId, productId, scheduleId, JSON.stringify(snapshot)],
  );
  await sql(
    `INSERT INTO report_deliveries (organization_id, report_id, kind, target, status, attempts, last_error)
     VALUES ($1, $2, 'email', 'cto@example.com', 'dead', 5, '550 mailbox unavailable')`,
    [orgId, id],
  );
  return id;
}

describe('report schedules (WB-15 UC-15-01)', () => {
  it('creates with the next run, lists, updates (recomputing the next run), deletes, and audits', async () => {
    const { owner, productId, channelId } = await setup();
    const base = `/api/v1/products/${productId}/report-schedules`;
    const res = await create(owner.cookie, productId, daily(channelId));
    expect(res.statusCode, res.body).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({
      name: 'Daily summary',
      timezone: 'Europe/Berlin',
      localTime: '08:00',
      channelIds: [channelId],
      recipients: ['cto@example.com'],
      enabled: true,
      nextRunAt: '2026-10-26T07:00:00.000Z',
    });
    expect((await call(owner.cookie, 'GET', base)).json().schedules).toEqual([
      expect.objectContaining({ id: s.id }),
    ]);
    const patched = await call(owner.cookie, 'PATCH', `/api/v1/report-schedules/${s.id}`, {
      timezone: 'Asia/Karachi',
      localTime: '09:30',
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().nextRunAt).toBe('2026-10-26T04:30:00.000Z');
    expect((await call(owner.cookie, 'DELETE', `/api/v1/report-schedules/${s.id}`)).statusCode).toBe(204);
    const audit = await sql<{ action: string }>(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'report_schedule.%' ORDER BY created_at`,
      [owner.orgId],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'report_schedule.create',
      'report_schedule.update',
      'report_schedule.delete',
    ]);
  });

  it('refuses unknown timezones, bad times, foreign channels, too many recipients, and no destination', async () => {
    const { owner, productId, channelId } = await setup();
    const other = await setup();
    for (const bad of [
      daily(channelId, { timezone: 'Mars/Base' }),
      daily(channelId, { localTime: '25:00' }),
      daily(other.channelId),
      daily(channelId, { recipients: Array.from({ length: 11 }, (_, i) => `r${i}@example.com`) }),
      daily(channelId, { recipients: ['not-an-email'] }),
      daily(channelId, { channelIds: [], recipients: [] }),
    ])
      expect((await create(owner.cookie, productId, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    // Another organization's product, or none: not found (Review Focus #4).
    expect((await create(owner.cookie, other.productId, daily(channelId))).statusCode).toBe(404);
    expect((await call(owner.cookie, 'POST', '/api/v1/report-schedules', daily(channelId))).statusCode).toBe(
      404,
    );
  });

  it('resuming a long-paused schedule starts from the next run, not every missed day', async () => {
    const { owner, productId, channelId } = await setup();
    const s = (await create(owner.cookie, productId, daily(channelId))).json();
    await call(owner.cookie, 'PATCH', `/api/v1/report-schedules/${s.id}`, { enabled: false });
    await sql(`UPDATE report_schedules SET next_run_at = '2026-09-01T06:00:00Z' WHERE id = $1`, [s.id]);
    const resumed = await call(owner.cookie, 'PATCH', `/api/v1/report-schedules/${s.id}`, { enabled: true });
    expect(resumed.json().nextRunAt).toBe('2026-10-26T07:00:00.000Z');
  });

  it('previews the next run and the window length (Review Focus #1)', async () => {
    const { owner, productId } = await setup();
    const res = await call(
      owner.cookie,
      'GET',
      `/api/v1/products/${productId}/report-schedules/preview?timezone=Europe/Berlin&localTime=08:00`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      nextRunAt: '2026-10-26T07:00:00.000Z',
      localDate: '2026-10-25',
      windowHours: 25,
    });
  });

  it('runs now for the prior local day and queues the job', async () => {
    const { owner, productId, channelId } = await setup();
    const s = (await create(owner.cookie, productId, daily(channelId))).json();
    const res = await call(owner.cookie, 'POST', `/api/v1/report-schedules/${s.id}/run`, {});
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ localDate: '2026-10-24', version: 1 });
    expect(await queued()).toContain(`report-generate__${owner.orgId}__${s.id}__2026-10-24__v1`);
  });

  it('lets viewers read, not manage; other tenants get 404 (Review Focus #4)', async () => {
    const a = await setup();
    const b = await setup();
    const s = (
      await call(
        a.owner.cookie,
        'POST',
        `/api/v1/products/${a.productId}/report-schedules`,
        daily(a.channelId),
      )
    ).json();
    const viewer = await member(a.owner, 'viewer');
    expect((await call(viewer, 'GET', `/api/v1/products/${a.productId}/report-schedules`)).statusCode).toBe(
      200,
    );
    expect((await create(viewer, a.productId, daily(a.channelId))).statusCode).toBe(404);
    expect(
      (await call(b.owner.cookie, 'PATCH', `/api/v1/report-schedules/${s.id}`, { enabled: false }))
        .statusCode,
    ).toBe(404);
    const report = await seedReport(a.owner.orgId, a.productId, s.id);
    expect((await call(b.owner.cookie, 'GET', `/api/v1/reports/${report}`)).statusCode).toBe(404);
    expect((await call(viewer, 'GET', `/api/v1/reports/${report}`)).statusCode).toBe(200);
  });
});

describe('report history (WB-15 UC-15-04/09)', () => {
  it('lists reports, opens one with sections and deliveries, and regenerates a new version', async () => {
    const { owner, productId, channelId } = await setup();
    const s = (await create(owner.cookie, productId, daily(channelId))).json();
    const id = await seedReport(owner.orgId, productId, s.id);
    const list = (await call(owner.cookie, 'GET', `/api/v1/products/${productId}/reports`)).json();
    expect(list.reports).toEqual([
      expect.objectContaining({
        id,
        localDate: '2026-10-24',
        version: 1,
        narrativeStatus: 'deferred',
        scheduleName: 'Daily summary',
      }),
    ]);
    const one = (await call(owner.cookie, 'GET', `/api/v1/reports/${id}`)).json();
    expect(one.snapshot.sections[0]).toMatchObject({
      status: 'missing',
      reason: 'Google Analytics not connected (M13b)',
    });
    expect(one.deliveries).toEqual([
      expect.objectContaining({
        kind: 'email',
        target: 'cto@example.com',
        status: 'dead',
        attempts: 5,
        lastError: '550 mailbox unavailable',
      }),
    ]);
    const regen = await call(owner.cookie, 'POST', `/api/v1/reports/${id}/regenerate`, {});
    expect(regen.statusCode, regen.body).toBe(202);
    expect(regen.json()).toEqual({ version: 2 });
    expect(await queued()).toContain(`report-generate__${owner.orgId}__${s.id}__2026-10-24__v2`);
  });

  it('cannot regenerate a report whose schedule was deleted', async () => {
    const { owner, productId } = await setup();
    const id = await seedReport(owner.orgId, productId, null);
    expect((await call(owner.cookie, 'POST', `/api/v1/reports/${id}/regenerate`, {})).statusCode).toBe(409);
  });
});
