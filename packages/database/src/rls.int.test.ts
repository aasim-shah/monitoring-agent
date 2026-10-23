import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_TABLES } from './index.js';
import { startPostgres, type TestDatabase } from './testing.js';

let db: TestDatabase;
const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function asApp<T>(org: string | null, fn: (c: pg.Client) => Promise<T>, user?: string): Promise<T> {
  return withClient(db.appUrl, async (c) => {
    await c.query('BEGIN');
    try {
      if (org) await c.query(`SELECT set_config('app.organization_id', $1, true)`, [org]);
      if (user) await c.query(`SELECT set_config('app.user_id', $1, true)`, [user]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

beforeAll(async () => {
  db = await startPostgres();
  await withClient(db.superuserUrl, async (c) => {
    await c.query(`INSERT INTO users (id, email) VALUES ($1, 'a@example.com')`, [userA]);
    for (const [org, name] of [
      [orgA, 'Org A'],
      [orgB, 'Org B'],
    ]) {
      await c.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [org, name]);
      const product = randomUUID();
      await c.query(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'P')`, [product, org]);
      const environment = randomUUID();
      await c.query(
        `INSERT INTO environments (id, organization_id, product_id, name) VALUES ($1, $2, $3, 'Production')`,
        [environment, org, product],
      );
      await c.query(`INSERT INTO teams (id, organization_id, name) VALUES ($1, $2, 'Core')`, [
        randomUUID(),
        org,
      ]);
      await c.query(
        `INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'x@example.com', 'viewer', $3, $4, now() + interval '7 days')`,
        [randomUUID(), org, `hash-${org}`, userA],
      );
      await c.query(
        `INSERT INTO audit_logs (id, organization_id, actor_type, action, target_type) VALUES ($1, $2, 'system', 'seed', 'organization')`,
        [randomUUID(), org],
      );
      const conn = randomUUID();
      await c.query(
        `INSERT INTO connections (id, organization_id, provider, display_name, execution_location, updated_at)
         VALUES ($1, $2, 'mock', 'Mock', 'cloud', now())`,
        [conn, org],
      );
      await c.query(
        `INSERT INTO connection_secrets (connection_id, organization_id, ciphertext, key_version) VALUES ($1, $2, 'x', 1)`,
        [conn, org],
      );
      await c.query(
        `INSERT INTO connection_resource_scopes (id, organization_id, connection_id, external_id, resource_type, name, product_id)
         VALUES ($1, $2, $3, 'r1', 'zone', 'Zone', $4)`,
        [randomUUID(), org, conn, product],
      );
      await c.query(
        `INSERT INTO connection_health (id, organization_id, connection_id, ok) VALUES ($1, $2, $3, true)`,
        [randomUUID(), org, conn],
      );
      await c.query(
        `INSERT INTO sync_runs (id, organization_id, connection_id, kind) VALUES ($1, $2, $3, 'validate')`,
        [randomUUID(), org, conn],
      );
      await c.query(
        `INSERT INTO job_definitions (id, organization_id, kind, entity_id, every_seconds) VALUES ($1, $2, 'connection-validate', $3, 900)`,
        [randomUUID(), org, conn],
      );
      await c.query(
        `INSERT INTO job_executions (id, organization_id, job_id, kind, status, attempts) VALUES ($1, $2, 'j', 'connection-validate', 'succeeded', 1)`,
        [randomUUID(), org],
      );
      const enrollment = randomUUID();
      await c.query(
        `INSERT INTO agent_enrollments (id, organization_id, product_id, environment_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [enrollment, org, product, environment, `enr-${org}`],
      );
      const agent = randomUUID();
      await c.query(
        `INSERT INTO agents (id, organization_id, product_id, environment_id, enrollment_id, agent_type, hostname, machine_id, os, arch, agent_version)
         VALUES ($1, $2, $3, $4, $5, 'host', 'h', 'm', 'linux', 'amd64', '1.0.0')`,
        [agent, org, product, environment, enrollment],
      );
      await c.query(
        `INSERT INTO agent_credentials (id, organization_id, agent_id, fingerprint_sha256, serial, not_after)
         VALUES ($1, $2, $3, $4, 's', now() + interval '30 days')`,
        [randomUUID(), org, agent, `fp-${org}`],
      );
      await c.query(
        `INSERT INTO agent_public_keys (id, organization_id, agent_id, kind, public_key) VALUES ($1, $2, $3, 'x25519', 'k')`,
        [randomUUID(), org, agent],
      );
      await c.query(
        `INSERT INTO agent_heartbeats (id, organization_id, agent_id, sent_at, sequence, health, queue_depth, agent_version, policy_version)
         VALUES ($1, $2, $3, now(), 1, 'ok', 0, '1.0.0', 1)`,
        [randomUUID(), org, agent],
      );
      const task = randomUUID();
      await c.query(
        `INSERT INTO agent_tasks (id, organization_id, agent_id, type, expires_at, max_runtime_seconds, max_response_bytes, signature)
         VALUES ($1, $2, $3, 'inspect', now() + interval '10 minutes', 60, 65536, 'sig')`,
        [task, org, agent],
      );
      await c.query(
        `INSERT INTO agent_task_results (task_id, organization_id, agent_id, status) VALUES ($1, $2, $3, 'succeeded')`,
        [task, org, agent],
      );
      await c.query(
        `INSERT INTO agent_inventories (agent_id, organization_id, collected_at, services, listeners, warnings)
         VALUES ($1, $2, now(), '[]', '[]', '[]')`,
        [agent, org],
      );
      await c.query(
        `INSERT INTO agent_pack_assignments (id, organization_id, agent_id, pack_id, settings, policy_version, updated_at)
         VALUES ($1, $2, $3, 'redis', '{}', 2, now())`,
        [randomUUID(), org, agent],
      );
      await c.query(
        `INSERT INTO agent_stream_sessions (id, organization_id, agent_id, task_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
        [randomUUID(), org, agent, task],
      );
      const host = randomUUID();
      const service = randomUUID();
      await c.query(
        `INSERT INTO assets (id, organization_id, asset_type, name, source, identity_key)
         VALUES ($1, $2, 'host', 'vps-1', 'agent', $4), ($3, $2, 'service', 'redis', 'agent', $5)`,
        [host, org, service, `agent:${host}`, `svc:${service}`],
      );
      await c.query(
        `INSERT INTO asset_aliases (id, organization_id, asset_id, candidate_asset_id, reason) VALUES ($1, $2, $3, $4, 'same name')`,
        [randomUUID(), org, host, service],
      );
      await c.query(
        `INSERT INTO asset_observations (id, organization_id, asset_id, source, attributes) VALUES ($1, $2, $3, 'agent', '{}')`,
        [randomUUID(), org, host],
      );
      await c.query(
        `INSERT INTO product_assets (organization_id, product_id, asset_id) VALUES ($1, $2, $3)`,
        [org, product, host],
      );
      const edge = randomUUID();
      await c.query(
        `INSERT INTO asset_relationships (id, organization_id, source_asset_id, target_asset_id, relationship_type, confidence, updated_at)
         VALUES ($1, $2, $3, $4, 'HOSTS', 0.95, now())`,
        [edge, org, host, service],
      );
      await c.query(
        `INSERT INTO relationship_evidence (id, organization_id, relationship_id, kind) VALUES ($1, $2, $3, 'direct')`,
        [randomUUID(), org, edge],
      );
      await c.query(
        `INSERT INTO discovery_runs (id, organization_id, product_id, source) VALUES ($1, $2, $3, 'agent')`,
        [randomUUID(), org, product],
      );
      const [rule, incident, channel] = [randomUUID(), randomUUID(), randomUUID()];
      await c.query(
        `INSERT INTO alert_rules (id, organization_id, product_id, name, template, params, severity, updated_at)
         VALUES ($1, $2, $3, 'CPU high', 'host_cpu_high', '{}', 'warning', now())`,
        [rule, org, product],
      );
      await c.query(
        `INSERT INTO alert_incidents (id, organization_id, product_id, rule_id, fingerprint, title, severity, started_at)
         VALUES ($1, $2, $3, $4, 'fp', 'CPU high on vps-1', 'warning', now())`,
        [incident, org, product, rule],
      );
      await c.query(
        `INSERT INTO incident_events (id, organization_id, incident_id, kind) VALUES ($1, $2, $3, 'fired')`,
        [randomUUID(), org, incident],
      );
      await c.query(
        `INSERT INTO notification_channels (id, organization_id, name, kind, config, updated_at)
         VALUES ($1, $2, 'Ops email', 'email', '{"recipients":["ops@example.com"]}', now())`,
        [channel, org],
      );
      await c.query(
        `INSERT INTO notification_deliveries (id, organization_id, channel_id, incident_id, event)
         VALUES ($1, $2, $3, $4, 'opened')`,
        [randomUUID(), org, channel, incident],
      );
      await c.query(`INSERT INTO ai_settings (organization_id, updated_at) VALUES ($1, now())`, [org]);
      const [conversation, run] = [randomUUID(), randomUUID()];
      await c.query(
        `INSERT INTO ai_conversations (id, organization_id, product_id, title, updated_at) VALUES ($1, $2, $3, 'Why slow?', now())`,
        [conversation, org, product],
      );
      await c.query(
        `INSERT INTO ai_runs (id, organization_id, conversation_id, provider, model) VALUES ($1, $2, $3, 'gemini', 'gemini-2.5-flash')`,
        [run, org, conversation],
      );
      await c.query(
        `INSERT INTO ai_messages (id, organization_id, conversation_id, role, content) VALUES ($1, $2, $3, 'user', 'Why slow?')`,
        [randomUUID(), org, conversation],
      );
      await c.query(
        `INSERT INTO ai_tool_executions (id, organization_id, run_id, tool, input, status) VALUES ($1, $2, $3, 'listAssets', '{}', 'ok')`,
        [randomUUID(), org, run],
      );
      await c.query(
        `INSERT INTO website_monitors (id, organization_id, product_id, url, host, verify_token, updated_at)
         VALUES ($1, $2, $3, 'https://shop.example.com', 'shop.example.com', 'tok', now())`,
        [randomUUID(), org, product],
      );
      const [schedule, report] = [randomUUID(), randomUUID()];
      await c.query(
        `INSERT INTO report_schedules (id, organization_id, product_id, name, timezone, local_time, next_run_at, updated_at)
         VALUES ($1, $2, $3, 'Daily', 'Europe/Berlin', '08:00', now(), now())`,
        [schedule, org, product],
      );
      await c.query(
        `INSERT INTO generated_reports (id, organization_id, product_id, schedule_id, local_date, window_start, window_end, timezone, snapshot, narrative_status)
         VALUES ($1, $2, $3, $4, '2026-10-25', now(), now(), 'Europe/Berlin', '{}', 'deferred')`,
        [report, org, product, schedule],
      );
      await c.query(
        `INSERT INTO report_deliveries (id, organization_id, report_id, kind, target) VALUES ($1, $2, $3, 'email', 'ops@example.com')`,
        [randomUUID(), org, report],
      );
      const [env, actionRequest] = [randomUUID(), randomUUID()];
      await c.query(
        `INSERT INTO environments (id, organization_id, product_id, name) VALUES ($1, $2, $3, 'staging')`,
        [env, org, product],
      );
      await c.query(
        `INSERT INTO action_policies (organization_id, product_id, environment_id, capability, updated_at)
         VALUES ($1, $2, $3, 'host.restart_service', now())`,
        [org, product, env],
      );
      await c.query(
        `INSERT INTO action_requests (id, organization_id, product_id, environment_id, capability, target, target_key, idempotency_key, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, 'host.restart_service', '{}', 'k', 'idem', now(), now())`,
        [actionRequest, org, product, env],
      );
      await c.query(
        `INSERT INTO action_approvals (organization_id, request_id, user_id, decision) VALUES ($1, $2, $3, 'approve')`,
        [org, actionRequest, randomUUID()],
      );
      await c.query(
        `INSERT INTO action_executions (organization_id, request_id, target_key, location, adapter, adapter_version)
         VALUES ($1, $2, 'k', 'agent', 'host.restart_service', '0.3.0')`,
        [org, actionRequest],
      );
    }
    await c.query(
      `INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner'), ($4, $5, $3, 'viewer')`,
      [randomUUID(), orgA, userA, randomUUID(), orgB],
    );
  });
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('row-level security', () => {
  it('every tenant table has RLS enabled and forced', async () => {
    const rows = await withClient(
      db.superuserUrl,
      async (c) =>
        (
          await c.query(
            `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r'`,
            [TENANT_TABLES],
          )
        ).rows,
    );
    expect(rows).toHaveLength(TENANT_TABLES.length);
    for (const r of rows) {
      expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it.each(TENANT_TABLES)('%s returns no rows without tenant context', async (table) => {
    const { rows } = await asApp(null, (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`));
    expect(rows[0].n).toBe(0);
  });

  it.each(TENANT_TABLES)('%s returns only the current tenant rows', async (table) => {
    const column = table === 'organizations' ? 'id' : 'organization_id';
    const { rows } = await asApp(orgA, (c) => c.query(`SELECT DISTINCT ${column} AS org FROM ${table}`));
    expect(rows.map((r) => r.org)).toEqual([orgA]);
  });

  it('rejects writing another tenant row', async () => {
    await expect(
      asApp(orgA, (c) =>
        c.query(`INSERT INTO products (id, organization_id, name) VALUES ($1, $2, 'evil')`, [
          randomUUID(),
          orgB,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('lists the user memberships across organizations without tenant context', async () => {
    const { rows } = await asApp(null, (c) =>
      c.query(`SELECT organization_id, role FROM pcp_user_memberships($1) ORDER BY role`, [userA]),
    );
    expect(rows).toEqual([
      { organization_id: orgA, role: 'owner' },
      { organization_id: orgB, role: 'viewer' },
    ]);
  });

  it('resolves a product organization only for members', async () => {
    const product = await withClient(
      db.superuserUrl,
      async (c) => (await c.query(`SELECT id FROM products WHERE organization_id = $1`, [orgA])).rows[0].id,
    );
    const member = await asApp(null, (c) =>
      c.query(`SELECT pcp_resolve_product_org($1, $2) AS org`, [product, userA]),
    );
    expect(member.rows[0].org).toBe(orgA);
    const stranger = await asApp(null, (c) =>
      c.query(`SELECT pcp_resolve_product_org($1, $2) AS org`, [product, randomUUID()]),
    );
    expect(stranger.rows[0].org).toBeNull();
  });
});

describe('database roles', () => {
  it('pcp_app cannot bypass RLS and owns nothing', async () => {
    await withClient(db.superuserUrl, async (c) => {
      const role = await c.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'pcp_app'`);
      expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
      const owned = await c.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'pcp_app'`,
      );
      expect(owned.rows[0].n).toBe(0);
    });
  });

  it('pcp_app cannot update or delete audit logs', async () => {
    await expect(asApp(orgA, (c) => c.query(`UPDATE audit_logs SET action = 'x'`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asApp(orgA, (c) => c.query(`DELETE FROM audit_logs`))).rejects.toThrow(/permission denied/);
  });

  it('pcp_app cannot read the Prisma migrations table', async () => {
    await expect(asApp(null, (c) => c.query(`SELECT * FROM _prisma_migrations`))).rejects.toThrow(
      /permission denied/,
    );
  });
});
