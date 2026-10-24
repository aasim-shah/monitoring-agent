import { gzipSync } from 'node:zlib';
import { TENANT_TABLES, type PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';

/** How long an export's download link works (WB-17 UC-17-09). */
export const EXPORT_TTL_MS = 24 * 3600 * 1000;
/** Rows per table in one archive; larger tables are cut and say so. */
const MAX_ROWS = 100_000;

/**
 * What an export contains: table → columns left out. Tables not listed (credentials, enrollment
 * tokens, connection secrets, agent tasks, raw observations) are never exported.
 */
const EXPORTED: Record<string, string[]> = {
  products: [],
  environments: [],
  teams: [],
  invitations: ['token_hash'],
  connections: [],
  connection_resource_scopes: [],
  connection_health: [],
  connection_inventory: [],
  sync_runs: [],
  webhook_deliveries: [],
  change_events: [],
  metric_aggregates: [],
  agents: [],
  agent_inventories: [],
  agent_pack_assignments: ['sealed_credentials'],
  assets: [],
  asset_aliases: [],
  product_assets: [],
  asset_relationships: [],
  relationship_evidence: [],
  alert_rules: [],
  alert_incidents: [],
  incident_events: [],
  notification_channels: ['secret'],
  notification_deliveries: [],
  website_monitors: [],
  report_schedules: [],
  generated_reports: [],
  report_deliveries: [],
  action_policies: [],
  action_requests: [],
  action_approvals: [],
  action_executions: [],
  ai_settings: [],
  ai_conversations: [],
  ai_messages: [],
  audit_logs: [],
};

export interface TenantDeps {
  prisma: PrismaClient;
  now(): Date;
}

/** JSON-safe values: bytes as base64, everything else as is. */
const plain = (row: Record<string, unknown>, omit: string[]) =>
  Object.fromEntries(
    Object.entries(row)
      .filter(([k]) => !omit.includes(k))
      .map(([k, v]) => [
        k,
        Buffer.isBuffer(v) ? v.toString('base64') : typeof v === 'bigint' ? Number(v) : v,
      ]),
  );

export function tenantHandlers(deps: TenantDeps) {
  return {
    /** Builds the archive for one export row (entity = export ID). */
    'tenant-export': async (ctx: TenantContext, exportId: string) => {
      try {
        const archive = await withTenant(deps.prisma, ctx, async (tx) => {
          const exp = await tx.tenantExport.findUnique({ where: { id: exportId } });
          if (!exp || exp.status !== 'queued') return null;
          const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
          const members = await tx.organizationMember.findMany({
            include: { user: { select: { email: true } } },
          });
          const tables: Record<string, unknown[]> = {
            members: members.map((m) => ({
              email: m.user.email,
              role: m.role,
              all_products: m.allProducts,
              product_ids: m.productIds,
              created_at: m.createdAt,
            })),
          };
          const truncated: string[] = [];
          for (const [table, omit] of Object.entries(EXPORTED)) {
            // Table names come from the constant above, never from input; RLS limits rows to this tenant.
            const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
              `SELECT * FROM "${table}" LIMIT ${MAX_ROWS + 1}`,
            );
            if (rows.length > MAX_ROWS) truncated.push(table);
            tables[table] = rows.slice(0, MAX_ROWS).map((r) => plain(r, omit));
          }
          return {
            format: 'pcp-tenant-export/1',
            exportedAt: deps.now().toISOString(),
            organization: {
              id: org.id,
              name: org.name,
              timezone: org.timezone,
              settings: org.settings,
              created_at: org.createdAt,
            },
            truncated,
            tables,
          };
        });
        if (!archive) return { skipped: 'export not queued' };
        const gz = gzipSync(JSON.stringify(archive));
        await withTenant(deps.prisma, ctx, (tx) =>
          tx.tenantExport.update({
            where: { id: exportId },
            data: {
              status: 'ready',
              archive: gz,
              sizeBytes: gz.length,
              expiresAt: new Date(deps.now().getTime() + EXPORT_TTL_MS),
            },
          }),
        );
        return { bytes: gz.length };
      } catch (err) {
        await withTenant(deps.prisma, ctx, (tx) =>
          tx.tenantExport.updateMany({
            where: { id: exportId },
            data: { status: 'failed', error: (err as Error).message.slice(0, 500) },
          }),
        );
        throw err;
      }
    },
  };
}

export interface PurgeDeps {
  prisma: PrismaClient;
  /** pcp_scheduler: finds due organizations without bypassing RLS (BR-15-07 pattern). */
  scheduler: PrismaClient;
  now(): Date;
  /** VictoriaMetrics single-node URL for the delete-series API; telemetry is skipped without it. */
  vmUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Purges organizations whose grace period ended (WB-17 UC-17-09): telemetry series first (idempotent),
 * then every tenant-table row; a summary of what was removed is kept in deleted_organizations.
 * Also clears export archives whose 24-hour link expired.
 */
export async function purgeDueTenants(deps: PurgeDeps): Promise<{ purged: string[] }> {
  const doFetch = deps.fetch ?? fetch;
  await deps.scheduler.$queryRaw`SELECT pcp_expire_tenant_exports(${deps.now()})`;
  const due = await deps.scheduler.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM pcp_due_tenant_purges(${deps.now()})`;
  const purged: string[] = [];
  for (const { id } of due) {
    if (deps.vmUrl) {
      const res = await doFetch(
        `${deps.vmUrl}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{tenant_id="${id}"}`)}`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(`VictoriaMetrics delete_series answered ${res.status} for ${id}`);
    }
    // Audit entries are append-only for the app; the scheduler role purges them for due organizations only.
    await deps.scheduler.$queryRaw`SELECT pcp_purge_audit_logs(${id}::uuid, ${deps.now()})`;
    const ctx: TenantContext = {
      organizationId: id,
      actor: { kind: 'system', jobId: 'tenant-purge' },
      roles: ['owner'],
      productIds: 'all',
      environmentIds: 'all',
      requestId: `purge-${id}`,
    };
    await withTenant(deps.prisma, ctx, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id } });
      if (!org || !org.deletionScheduledFor || org.deletionScheduledFor > deps.now()) return;
      const summary: Record<string, number> = {};
      for (const table of TENANT_TABLES) {
        if (table === 'organizations') continue;
        const [r] = await tx.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM "${table}"`,
        );
        if (r?.n) summary[table] = r.n;
      }
      // Children first where no cascade exists, then the organization (cascades the rest).
      for (const table of [...TENANT_TABLES].reverse()) {
        if (table === 'organizations' || table === 'audit_logs') continue;
        await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
      }
      await tx.organization.delete({ where: { id } });
      // Insert-only for the app (no read back): the record outlives the tenant.
      await tx.deletedOrganization.createMany({
        data: [
          {
            id,
            name: org.name,
            deletionRequestedAt: org.deletionRequestedAt ?? org.deletionScheduledFor,
            summary,
          },
        ],
      });
    });
    purged.push(id);
  }
  return { purged };
}
