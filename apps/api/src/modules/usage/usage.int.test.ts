import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/app-factory.js';
import { headers, ownerWithOrg } from '../../../test/auth-helpers.js';
import { sql } from '../../../test/db.js';

const TOKEN = 'internal-token-for-usage-tests-000';
let t: TestApp;
let now = new Date('2026-10-25T10:00:30Z');

beforeAll(async () => {
  t = await createTestApp({ env: { INTERNAL_TOKEN: TOKEN }, clock: () => now });
});

afterAll(async () => {
  await t?.close();
});

const report = (tenants: object[], token = TOKEN) =>
  t.app.inject({
    method: 'POST',
    url: '/internal/v1/telemetry-usage',
    headers: { 'content-type': 'application/json', 'x-internal-token': token },
    payload: { tenants },
  });

const usage = (cookie: string, orgId: string) => {
  const { 'content-type': _ct, ...bare } = headers(cookie);
  return t.app.inject({
    method: 'GET',
    url: `/api/v1/organizations/${orgId}/usage?range=24h`,
    headers: bare,
  });
};

describe('telemetry usage (M10.6, spec §11.6, TC-11-08)', () => {
  it('refuses a report without the internal token (Review Focus #3)', async () => {
    expect((await report([], 'wrong')).statusCode).toBe(401);
  });

  it('stores per-minute usage, shows it to members, and warns while refusals are recent', async () => {
    const owner = await ownerWithOrg(t);
    const tenant = (o: object) => ({
      organizationId: owner.orgId,
      activeSeries: 120,
      samples: 3600,
      refusedSeriesRequests: 0,
      refusedRateRequests: 0,
      ...o,
    });
    expect((await report([tenant({})])).statusCode).toBe(204);
    now = new Date('2026-10-25T10:01:30Z');
    await report([tenant({ activeSeries: 125, samples: 3000 })]);
    const res = await usage(owner.cookie, owner.orgId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      totals: { samples: 6600, activeSeries: 125, refusedRequests: 0 },
      limits: { agentSeries: 20000, tenantSeries: 200000, agentSamplesPerSecond: 10000 },
      overLimitSince: null,
    });

    now = new Date('2026-10-25T10:02:30Z');
    await report([tenant({ refusedSeriesRequests: 3 })]);
    const over = (await usage(owner.cookie, owner.orgId)).json();
    expect(over.overLimitSince).toBe('2026-10-25T10:02:00.000Z');
    expect(over.totals.refusedRequests).toBe(3);
    // The organization view carries the warning for the banner (Review Focus #4).
    const { 'content-type': _ct, ...bare } = headers(owner.cookie);
    const org = await t.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${owner.orgId}`,
      headers: bare,
    });
    expect(org.json().telemetryLimitSince).toBe('2026-10-25T10:02:00.000Z');

    // An hour without refusals clears the warning.
    now = new Date('2026-10-25T11:05:00Z');
    expect((await usage(owner.cookie, owner.orgId)).json().overLimitSince).toBeNull();
  });

  it('emails the owners at most once an hour about refusals', async () => {
    const owner = await ownerWithOrg(t);
    const refused = {
      organizationId: owner.orgId,
      activeSeries: 20000,
      samples: 10,
      refusedSeriesRequests: 2,
      refusedRateRequests: 0,
    };
    now = new Date('2026-10-25T12:00:30Z');
    await report([refused]);
    now = new Date('2026-10-25T12:20:30Z');
    await report([refused]);
    expect(t.mailer.to(owner.email).filter((m) => /limit/i.test(m.subject))).toHaveLength(1);
    now = new Date('2026-10-25T13:05:30Z');
    await report([refused]);
    const mails = t.mailer.to(owner.email).filter((m) => /limit/i.test(m.subject));
    expect(mails).toHaveLength(2);
    expect(mails[0]!.text).toMatch(/new series were refused/);
  });

  it('ignores tenants that do not exist', async () => {
    const res = await report([
      {
        organizationId: '00000000-0000-0000-0000-000000000000',
        activeSeries: 1,
        samples: 1,
        refusedSeriesRequests: 0,
        refusedRateRequests: 0,
      },
    ]);
    expect(res.statusCode).toBe(204);
  });
});
