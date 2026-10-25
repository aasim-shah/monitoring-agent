import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, scripted, type ChatProvider } from '@pcp/ai-orchestrator';
import { createPrismaClient, type PrismaClient } from '@pcp/database';
import { createQueues, type Queues } from '@pcp/jobs';
import type { TenantContext } from '@pcp/shared-contracts';
import {
  startPostgres,
  startRedis,
  TEST_PASSWORDS,
  type TestDatabase,
  type TestRedis,
} from '@pcp/test-support';
import { dispatchDueReports } from './report-dispatcher.js';
import { reportHandlers, type ReportDeps } from './report-handlers.js';
import { createReportSources } from './report-sources.js';
import { reauthorizationNotice } from './reauth-notice.js';

let db: TestDatabase;
let redis: TestRedis;
let prisma: PrismaClient;
let scheduler: PrismaClient;
let queues: Queues;
let vm: Server;
let vmPort = 0;
const vmQueries: string[] = [];
let websiteMonitor = '';
let mails: Array<{ to: string[]; subject: string; text: string }> = [];
const bouncing = new Set<string>();

async function sql(text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: db.superuserUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

const ctx = (organizationId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'test' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: 'r',
});

const job = (window: string, attemptsMade = 0) => ({ data: { window }, attemptsMade, opts: { attempts: 5 } });

const verified = () => scripted('fake', [{ text: 'Incidents were opened and 1 is still open [S2].' }]);

function deps(over: Partial<ReportDeps> = {}): ReportDeps {
  return {
    prisma,
    queues,
    now: () => new Date('2026-10-26T07:01:00Z'),
    provider: verified(),
    appOrigin: 'https://monitor.example.com',
    sources: createReportSources({ prisma, vmQueryUrl: `http://127.0.0.1:${vmPort}` }),
    delivery: {
      keyRing: new Map(),
      appOrigin: 'https://monitor.example.com',
      now: () => new Date('2026-10-26T07:01:00Z'),
      sendMail: async (m) => {
        if (m.to.some((t) => bouncing.has(t))) throw new Error('550 mailbox unavailable');
        mails.push(m);
      },
    },
    ...over,
  };
}

interface Seeded {
  org: string;
  product: string;
  schedule: string;
  user: string;
}

async function seed(): Promise<Seeded> {
  const [org, product, schedule, user, channel] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await sql(`INSERT INTO organizations (id, name) VALUES ($1, 'Acme')`, [org]);
  await sql(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'Shop')`, [product, org]);
  await sql(`INSERT INTO users (id, email) VALUES ($1, $2)`, [user, `${user}@example.com`]);
  await sql(
    `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'admin')`,
    [randomUUID(), org, user],
  );
  await sql(
    `INSERT INTO notification_channels (id, organization_id, name, kind, config, updated_at)
     VALUES ($1, $2, 'Ops', 'email', '{"recipients":["ops@example.com"]}', now())`,
    [channel, org],
  );
  await sql(
    `INSERT INTO report_schedules (id, organization_id, product_id, name, timezone, local_time, channel_ids, recipients, next_run_at, created_by_user_id, updated_at)
     VALUES ($1, $2, $3, 'Daily', 'Europe/Berlin', '08:00', ARRAY[$4]::uuid[], ARRAY['cto@example.com'], '2026-10-26T07:00:00Z', $5, now())`,
    [schedule, org, product, channel, user],
  );
  await sql(
    `INSERT INTO alert_rules (id, organization_id, product_id, name, template, params, severity, updated_at)
     VALUES ($1, $2, $3, 'CPU', 'host_cpu_high', '{}', 'critical', now())`,
    [randomUUID(), org, product],
  );
  const rule = (await sql(`SELECT id FROM alert_rules WHERE organization_id = $1`, [org]))[0]!.id;
  await sql(
    `INSERT INTO alert_incidents (id, organization_id, product_id, rule_id, fingerprint, title, severity, status, started_at)
     VALUES ($1, $2, $3, $4, 'fp-1', 'CPU high', 'critical', 'open', '2026-10-25T10:00:00Z')`,
    [randomUUID(), org, product, rule],
  );
  return { org, product, schedule, user };
}

const reports = (s: Seeded) =>
  sql(`SELECT * FROM generated_reports WHERE schedule_id = $1 ORDER BY version`, [s.schedule]);
const deliveries = (s: Seeded) =>
  sql(
    `SELECT d.* FROM report_deliveries d JOIN generated_reports r ON r.id = d.report_id WHERE r.schedule_id = $1 ORDER BY d.target`,
    [s.schedule],
  );
const queued = async (kind: 'report-generate' | 'report-deliver') =>
  (await queues.get(kind).getJobs(['waiting', 'delayed'])).map((j) => j.id);

beforeAll(async () => {
  vm = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const q = url.searchParams.get('query') ?? '';
    vmQueries.push(url.search);
    const series = (labels: Record<string, string>, value: number) => ({
      metric: labels,
      value: [0, String(value)],
    });
    let result: unknown[] = [];
    if (url.pathname.endsWith('/query_range')) {
      // Hourly uptime: checks in the first and third hour only.
      const start = Number(url.searchParams.get('start'));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: q.includes('website_up')
              ? [
                  {
                    metric: { monitor_id: websiteMonitor },
                    values: [
                      [start, '100'],
                      [start + 7200, '50'],
                    ],
                  },
                ]
              : [],
          },
        }),
      );
      return;
    }
    if (q.includes('system_cpu') && !q.includes('max_over_time'))
      result = [series({ agent_id: 'a-1' }, 41.25)];
    else if (q.includes('system_cpu')) result = [series({ agent_id: 'a-1' }, 93.5)];
    else if (q.includes('system_memory')) result = [series({ agent_id: 'a-1' }, 55)];
    else if (q.includes('system_filesystem')) result = [series({ agent_id: 'a-1' }, 71.2)];
    else if (q.includes('website_')) {
      // The previous window is read at its own end (the report window's start).
      const prev = Number(url.searchParams.get('time')) < Date.parse('2026-10-25T12:00:00Z') / 1000;
      const m = { monitor_id: websiteMonitor };
      if (q.includes('count_le_over_time')) result = [series(m, 3)];
      else if (q.includes('quantile_over_time')) result = [series(m, 410.4)];
      else if (q.includes('website_response_seconds')) result = [series(m, prev ? 200 : 230.6)];
      else result = [series(m, prev ? 100 : 99.52)];
    } else if (q.includes('level="error"')) result = [series({}, 12)];
    else if (q.includes('level="warn"')) result = [series({}, 30)];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result } }));
  });
  vmPort = await new Promise<number>((r) =>
    vm.listen(0, '127.0.0.1', () => r((vm.address() as { port: number }).port)),
  );
  [db, redis] = await Promise.all([startPostgres(), startRedis()]);
  prisma = createPrismaClient(db.appUrl);
  const u = new URL(db.superuserUrl);
  u.username = 'pcp_scheduler';
  u.password = TEST_PASSWORDS.scheduler;
  scheduler = createPrismaClient(u.toString());
  queues = createQueues(redis.url);
});

beforeEach(async () => {
  mails = [];
  bouncing.clear();
  for (const q of queues.all()) await q.obliterate({ force: true });
});

afterAll(async () => {
  await queues?.close();
  await Promise.all([prisma?.$disconnect(), scheduler?.$disconnect()]);
  await Promise.all([db?.stop(), redis?.stop(), new Promise((r) => vm.close(r))]);
});

describe('report dispatcher (BR-15-07)', () => {
  it('queues one generation for the prior local day and moves the schedule to the next run', async () => {
    const s = await seed();
    const now = () => new Date('2026-10-26T07:00:30Z');
    expect(await dispatchDueReports({ scheduler, prisma, queues, now })).toBeGreaterThanOrEqual(1);
    expect(await queued('report-generate')).toContain(`report-generate__${s.org}__${s.schedule}__2026-10-25`);
    const [row] = await sql(`SELECT next_run_at FROM report_schedules WHERE id = $1`, [s.schedule]);
    expect((row!.next_run_at as Date).toISOString()).toBe('2026-10-27T07:00:00.000Z');
    await dispatchDueReports({ scheduler, prisma, queues, now });
    expect((await queued('report-generate')).filter((id) => id?.includes(s.schedule))).toHaveLength(1);
  });
});

describe('report-generate and report-deliver (UC-15-02/03)', () => {
  it('generates the 12 sections once, delivers to the channel and the recipient, and records it', async () => {
    const s = await seed();
    const h = reportHandlers(deps());
    const out = await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    expect(out).toMatchObject({ version: 1, deliveries: 2 });
    const [report] = await reports(s);
    expect(report).toMatchObject({
      version: 1,
      narrative_status: 'verified',
      late: false,
      timezone: 'Europe/Berlin',
    });
    expect((report!.window_start as Date).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    const snapshot = report!.snapshot as { sections: Array<{ key: string; status: string; data: unknown }> };
    expect(snapshot.sections).toHaveLength(12);
    expect(snapshot.sections.find((x) => x.key === 'infrastructure')).toMatchObject({
      status: 'ok',
      data: { hosts: [{ hostname: 'a-1', cpuAvg: 41.3, cpuMax: 93.5, memoryAvg: 55, diskMax: 71.2 }] },
    });
    expect(snapshot.sections.find((x) => x.key === 'health')!.data).toMatchObject({
      opened: 1,
      openCritical: 1,
    });
    expect(vmQueries.every((q) => q.includes(`extra_label=tenant_id%3D${s.org}`))).toBe(true);

    const ds = await deliveries(s);
    expect(ds.map((d) => [d.kind, d.status])).toEqual([
      ['email', 'pending'],
      ['email', 'pending'],
    ]);
    for (const d of ds) await h['report-deliver'](ctx(s.org), d.id, job(''));
    expect(mails.map((m) => m.to).sort()).toEqual([['cto@example.com'], ['ops@example.com']]);
    expect(mails[0]!.subject).toMatch(/^Daily report — Shop — 2026-10-25 · /);
    expect(mails[0]!.text).toContain('Data coverage and missing sources');
    expect(mails[0]!.text).toContain('Google Analytics not connected');
    expect((await deliveries(s)).map((d) => d.status)).toEqual(['sent', 'sent']);
  });

  it('TC-15-03: a restart after generation and before delivery keeps one report and sends each delivery once', async () => {
    const s = await seed();
    const h = reportHandlers(deps());
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25')); // the retried job after a crash
    expect(await reports(s)).toHaveLength(1);
    expect(await deliveries(s)).toHaveLength(2);
    for (const d of await deliveries(s)) {
      await h['report-deliver'](ctx(s.org), d.id, job(''));
      await h['report-deliver'](ctx(s.org), d.id, job('')); // a duplicate delivery job
    }
    expect(mails).toHaveLength(2);
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    expect(await queued('report-deliver')).toHaveLength(2 /* from the first two runs, none new */);
  });

  it('TC-15-04: with the AI provider down the report goes out with "Narrative deferred"', async () => {
    const s = await seed();
    const down: ChatProvider = {
      id: 'gemini',
      model: 'm',
      chat: async () => {
        throw new ProviderError('gemini answered HTTP 503', true, 503);
      },
    };
    const h = reportHandlers(deps({ provider: down }));
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    expect((await reports(s))[0]).toMatchObject({ narrative_status: 'deferred', narrative: null });
    const [d] = await deliveries(s);
    await h['report-deliver'](ctx(s.org), d!.id, job(''));
    expect(mails[0]!.text).toContain('Narrative deferred');
  });

  it('keeps AI off when the organization turned it off', async () => {
    const s = await seed();
    await sql(`INSERT INTO ai_settings (organization_id, disabled, updated_at) VALUES ($1, true, now())`, [
      s.org,
    ]);
    const provider = verified();
    await reportHandlers(deps({ provider }))['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    expect((await reports(s))[0]).toMatchObject({ narrative_status: 'disabled' });
    expect(provider.requests).toHaveLength(0);
  });

  it('M19.4: AI_DISABLED keeps every narrative off on this platform', async () => {
    const s = await seed();
    const provider = verified();
    await reportHandlers(deps({ provider, aiDisabled: true }))['report-generate'](
      ctx(s.org),
      s.schedule,
      job('2026-10-25'),
    );
    expect((await reports(s))[0]).toMatchObject({ narrative_status: 'disabled' });
    expect(provider.requests).toHaveLength(0);
  });

  it('TC-15-07: regenerating makes version 2 and leaves version 1 untouched', async () => {
    const s = await seed();
    const h = reportHandlers(deps());
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    const [v1] = await reports(s);
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25__v2'));
    const rows = await reports(s);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]).toEqual(v1);
  });

  it('does not run for a schedule whose owner lost access to the product', async () => {
    const s = await seed();
    await sql(`UPDATE organization_members SET all_products = false, product_ids = '{}' WHERE user_id = $1`, [
      s.user,
    ]);
    expect(
      await reportHandlers(deps())['report-generate'](ctx(s.org), s.schedule, job('2026-10-25')),
    ).toEqual({
      failed: 'not_found',
    });
    expect(await reports(s)).toHaveLength(0);
  });

  it('marks a run that starts 2 h after its time as late, for the same window', async () => {
    const s = await seed();
    await reportHandlers(deps({ now: () => new Date('2026-10-26T09:00:00Z') }))['report-generate'](
      ctx(s.org),
      s.schedule,
      job('2026-10-25'),
    );
    const [r] = await reports(s);
    expect(r).toMatchObject({ late: true });
    expect((r!.window_end as Date).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('records a failed delivery, retries, and dead-letters it on the last attempt', async () => {
    const s = await seed();
    bouncing.add('cto@example.com');
    const h = reportHandlers(deps());
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    const d = (await deliveries(s)).find((x) => x.target === 'cto@example.com')!;
    await expect(h['report-deliver'](ctx(s.org), d.id, job('', 0))).rejects.toThrow(/550/);
    expect((await deliveries(s)).find((x) => x.id === d.id)).toMatchObject({ status: 'failed', attempts: 1 });
    await expect(h['report-deliver'](ctx(s.org), d.id, job('', 4))).rejects.toThrow(/550/);
    expect((await deliveries(s)).find((x) => x.id === d.id)).toMatchObject({
      status: 'dead',
      attempts: 2,
      last_error: '550 mailbox unavailable',
    });
  });
  it('reports deployments from a product-scoped GitHub connection in the window', async () => {
    const s = await seed();
    const conn = randomUUID();
    await sql(
      `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, updated_at)
       VALUES ($1, $2, 'github', 'GitHub', 'connected', 'cloud', now())`,
      [conn, s.org],
    );
    await sql(
      `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, 'r-1', 'github_repository', 'acme/shop', $3)`,
      [s.org, conn, s.product],
    );
    const event = (kind: string, title: string, at: string) =>
      sql(
        `INSERT INTO change_events (organization_id, connection_id, product_id, provider, kind, title, external_id, occurred_at)
         VALUES ($1, $2, $3, 'github', $4, $5, $6, $7)`,
        [s.org, conn, s.product, kind, title, randomUUID(), at],
      );
    await event('deployment', 'shop deployed to production', '2026-10-25T09:00:00Z');
    await event('deployment_failed', 'shop deploy failed', '2026-10-25T11:00:00Z');
    await event('deployment', 'outside the window', '2026-10-27T09:00:00Z');
    const h = reportHandlers(deps());
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    const [report] = await reports(s);
    const snapshot = report!.snapshot as { sections: Array<{ key: string; status: string; data: unknown }> };
    expect(snapshot.sections.find((x) => x.key === 'deployments')).toMatchObject({
      status: 'ok',
      data: {
        deployed: 1,
        failed: 1,
        items: [{ title: 'shop deploy failed' }, { title: 'shop deployed to production' }],
      },
    });
  });
  it('reports the day of GA4 values from a product-scoped Google connection (M13b)', async () => {
    const s = await seed();
    const conn = randomUUID();
    await sql(
      `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, updated_at)
       VALUES ($1, $2, 'google', 'Google', 'connected', 'cloud', now())`,
      [conn, s.org],
    );
    await sql(
      `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, 'properties/1', 'google_ga4_property', 'Shop web', $3)`,
      [s.org, conn, s.product],
    );
    const v = (d: string, metric: string, value: number, completeness = 'complete') =>
      sql(
        `INSERT INTO metric_aggregates (organization_id, connection_id, resource_type, external_id, metric, day, value, completeness)
         VALUES ($1, $2, 'google_ga4_property', 'properties/1', $3, $4, $5, $6)`,
        [s.org, conn, metric, d, value, completeness],
      );
    await v('2026-10-25', 'activeUsers', 120, 'partial');
    await v('2026-10-24', 'activeUsers', 999);
    const h = reportHandlers(deps());
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    const [report] = await reports(s);
    const snapshot = report!.snapshot as { sections: Array<{ key: string; status: string; data: unknown }> };
    const analytics = snapshot.sections.find((x) => x.key === 'analytics')!;
    expect(analytics.status).toBe('ok');
    const [res] = (
      analytics.data as {
        resources: Array<{
          name: string;
          partial: boolean;
          values: Array<{ label: string; value: number | null }>;
        }>;
      }
    ).resources;
    expect(res).toMatchObject({ name: 'Shop web', source: 'GA4', partial: true });
    expect(res!.values.find((x) => x.label === 'Active users')!.value).toBe(120);
    expect(res!.values.find((x) => x.label === 'Sessions')!.value).toBeNull();
  });
});

describe('24 h activity and trends (M15b)', () => {
  const section = async (s: Seeded, key: string) => {
    const h = reportHandlers(deps());
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    const [report] = await reports(s);
    return (
      report!.snapshot as { sections: Array<{ key: string; status: string; data: unknown }> }
    ).sections.find((x) => x.key === key)!;
  };
  const postgres = async (s: Seeded) => {
    const conn = randomUUID();
    await sql(
      `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, updated_at)
       VALUES ($1, $2, 'postgres', 'Shop DB', 'connected', 'cloud', now())`,
      [conn, s.org],
    );
    await sql(
      `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, 'shop', 'postgres_database', 'shop', $3)`,
      [s.org, conn, s.product],
    );
    const health = (at: string, orders: [number, number], size: number, ok = true) =>
      sql(
        `INSERT INTO connection_health (organization_id, connection_id, checked_at, ok, detail) VALUES ($1, $2, $3, $4, $5)`,
        [
          s.org,
          conn,
          at,
          ok,
          JSON.stringify({
            databases: [{ name: 'shop', bytes: size }],
            tables: [
              { name: 'public.orders', rows: orders[0], inserted: orders[1] },
              { name: 'public.users', rows: 50, inserted: 50 },
            ],
          }),
        ],
      );
    return { conn, health };
  };

  it('counts rows added between the snapshots at the window start and end', async () => {
    const s = await seed();
    const { health } = await postgres(s);
    // Window for 2026-10-25 in Berlin: 2026-10-24T22:00Z to 2026-10-25T23:00Z (DST ends).
    await health('2026-10-24T21:30:00Z', [1000, 1200], 10_000_000);
    await health('2026-10-25T22:30:00Z', [1300, 1500], 12_000_000);
    await health('2026-10-25T22:45:00Z', [0, 0], 0, false);
    await health('2026-10-26T05:00:00Z', [9999, 9999], 99_000_000);
    const db = await section(s, 'databases');
    expect(db.status).toBe('ok');
    expect((db.data as { databases: unknown[] }).databases[0]).toMatchObject({
      name: 'Shop DB',
      // The last check failed; activity still compares the last good snapshots.
      ok: false,
      activity: {
        baseline: 'ok',
        approximate: false,
        rowsAdded: 300,
        sizeBytes: 12_000_000,
        sizeChangeBytes: 2_000_000,
        top: [{ name: 'public.orders', added: 300, total: 1300 }],
      },
    });
  });

  it('has no baseline when the last snapshot before the window is more than 6 h older', async () => {
    const s = await seed();
    const { health } = await postgres(s);
    await health('2026-10-24T15:00:00Z', [1000, 1200], 10_000_000);
    await health('2026-10-25T22:30:00Z', [1300, 1500], 12_000_000);
    const db = await section(s, 'databases');
    expect((db.data as { databases: Array<{ activity: unknown }> }).databases[0]!.activity).toMatchObject({
      baseline: 'none',
      rowsAdded: null,
    });
  });

  it('reports website speed, failed checks, and the previous window', async () => {
    const s = await seed();
    websiteMonitor = randomUUID();
    await sql(
      `INSERT INTO website_monitors (id, organization_id, product_id, url, host, verify_token, status, updated_at)
       VALUES ($1, $2, $3, 'https://shop.example.com/?token=x', 'shop.example.com', 't', 'active', now())`,
      [websiteMonitor, s.org, s.product],
    );
    const site = await section(s, 'availability');
    expect((site.data as { websites: unknown[] }).websites[0]).toEqual({
      url: 'https://shop.example.com/',
      uptimePercent: 99.5,
      tlsDays: null,
      avgMs: 231,
      p95Ms: 410,
      failedChecks: 3,
      previousUptimePercent: 100,
      previousAvgMs: 200,
      // 25 blocks: the Berlin day the clocks go back.
      hourly: [100, null, 50, ...Array.from({ length: 22 }, () => null)],
    });
  });

  it("keeps the earlier days' card values for the 7-day trend lines", async () => {
    const s = await seed();
    const h = reportHandlers(deps());
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-23'));
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-24'));
    await h['report-generate'](ctx(s.org), s.schedule, job('2026-10-25'));
    const latest = (await reports(s)).find(
      (r) => (r.snapshot as { window: { localDate: string } }).window.localDate === '2026-10-25',
    )!;
    const history = (latest.snapshot as { history: Array<{ day: string; values: Record<string, unknown> }> })
      .history;
    expect(history.map((x) => x.day)).toEqual(['2026-10-23', '2026-10-24']);
    expect(history[1]!.values).toMatchObject({ 'incidents.opened': expect.any(Number) });
  });

  it('reports the latest published day and the day before for each Google KPI', async () => {
    const s = await seed();
    const conn = randomUUID();
    await sql(
      `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, updated_at)
       VALUES ($1, $2, 'google', 'Google', 'connected', 'cloud', now())`,
      [conn, s.org],
    );
    const scope = (externalId: string, type: string, name: string) =>
      sql(
        `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [s.org, conn, externalId, type, name, s.product],
      );
    await scope('sc-domain:shop.example.com', 'google_search_console_site', 'shop.example.com');
    await scope('1:123:web:abc', 'google_firebase_app', 'Shop iOS');
    const v = (d: string, metric: string, value: number) =>
      sql(
        `INSERT INTO metric_aggregates (organization_id, connection_id, resource_type, external_id, metric, day, value, completeness)
         VALUES ($1, $2, 'google_search_console_site', 'sc-domain:shop.example.com', $3, $4, $5, 'complete')`,
        [s.org, conn, metric, d, value],
      );
    // Search Console publishes about 2 days late: nothing yet for 10-25 or 10-24.
    await v('2026-10-23', 'clicks', 120);
    await v('2026-10-22', 'clicks', 100);
    await v('2026-10-26', 'clicks', 999);
    const analytics = await section(s, 'analytics');
    const data = analytics.data as {
      reportDay: string;
      firebaseApps: string[];
      resources: Array<{ name: string; values: Array<Record<string, unknown>> }>;
    };
    expect(data.reportDay).toBe('2026-10-25');
    expect(data.firebaseApps).toEqual(['Shop iOS']);
    const site = data.resources.find((r) => r.name === 'shop.example.com')!;
    expect(site.values.find((x) => x.label === 'Search clicks')).toMatchObject({
      value: 120,
      day: '2026-10-23',
      previous: 100,
      previousDay: '2026-10-22',
    });
  });
});

describe('Google reauthorization notice (WB-08 UC-08-10)', () => {
  it('emails the member who connected and the owners, with a link to reconnect', async () => {
    mails = [];
    const s = await seed();
    const owner = randomUUID();
    await sql(`INSERT INTO users (id, email) VALUES ($1, $2)`, [owner, `${owner}@example.com`]);
    await sql(
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
      [randomUUID(), s.org, owner],
    );
    const conn = randomUUID();
    await sql(
      `INSERT INTO connections (id, organization_id, provider, display_name, status, execution_location, account_email, created_by_user_id, updated_at)
       VALUES ($1, $2, 'google', 'Google', 'degraded', 'cloud', 'ops@acme.example', $3, now())`,
      [conn, s.org, s.user],
    );
    await sql(
      `INSERT INTO connection_resource_scopes (organization_id, connection_id, external_id, resource_type, name, product_id)
       VALUES ($1, $2, 'properties/1', 'google_ga4_property', 'Shop web', $3)`,
      [s.org, conn, s.product],
    );
    await reauthorizationNotice({
      prisma,
      appOrigin: 'https://monitor.example.com',
      sendMail: deps().delivery.sendMail,
    })(ctx(s.org), conn);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toEqual([`${owner}@example.com`, `${s.user}@example.com`].sort());
    expect(mails[0]!.subject).toBe('Google connection needs reauthorization');
    expect(mails[0]!.text).toContain('granted by ops@acme.example');
    expect(mails[0]!.text).toContain(
      `https://monitor.example.com/orgs/${s.org}/products/${s.product}/integrations/${conn}`,
    );
  });
});
