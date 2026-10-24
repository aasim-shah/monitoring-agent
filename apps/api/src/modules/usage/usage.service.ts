import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG, CLOCK, PRISMA } from '../../tokens.js';
import { MAILER, type Mailer } from '../mail/mailer.js';

/** The ingest gateway's limits (apps/ingest-gateway/main.go, master plan §3). */
export const INGEST_LIMITS = { agentSeries: 20_000, tenantSeries: 200_000, agentSamplesPerSecond: 10_000 };
export const USAGE_RANGES = { '24h': 24, '7d': 7 * 24 } as const;
export type UsageRange = keyof typeof USAGE_RANGES;

const HOUR_MS = 3_600_000;

export interface TenantReport {
  organizationId: string;
  activeSeries: number;
  samples: number;
  refusedSeriesRequests: number;
  refusedRateRequests: number;
}

const system = (organizationId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'telemetry-usage' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: 'telemetry-usage',
});

/**
 * Per-tenant telemetry usage (M10.6, spec §11.6): the ingest gateway reports every minute; refusals
 * show as a warning for an hour and reach the owners by email at most once an hour (TC-11-08).
 */
@Injectable()
export class UsageService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async record(reports: TenantReport[]): Promise<void> {
    const now = this.now();
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    for (const r of reports) {
      const ctx = system(r.organizationId);
      const notice = await withTenant(this.prisma, ctx, async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: r.organizationId } });
        if (!org) return null;
        await tx.$executeRaw`
          INSERT INTO telemetry_usage (organization_id, minute, active_series, samples, refused_series_requests, refused_rate_requests)
          VALUES (${r.organizationId}::uuid, ${minute}, ${r.activeSeries}, ${r.samples}, ${r.refusedSeriesRequests}, ${r.refusedRateRequests})
          ON CONFLICT (organization_id, minute) DO UPDATE SET
            active_series = GREATEST(telemetry_usage.active_series, EXCLUDED.active_series),
            samples = telemetry_usage.samples + EXCLUDED.samples,
            refused_series_requests = telemetry_usage.refused_series_requests + EXCLUDED.refused_series_requests,
            refused_rate_requests = telemetry_usage.refused_rate_requests + EXCLUDED.refused_rate_requests`;
        if (r.refusedSeriesRequests + r.refusedRateRequests === 0) return null;
        const settings = (org.settings ?? {}) as Record<string, unknown>;
        const last =
          typeof settings.lastLimitNoticeAt === 'string' ? Date.parse(settings.lastLimitNoticeAt) : 0;
        if (now.getTime() - last < HOUR_MS) return null;
        await tx.organization.update({
          where: { id: org.id },
          data: { settings: { ...settings, lastLimitNoticeAt: now.toISOString() } as Prisma.InputJsonValue },
        });
        const owners = await tx.organizationMember.findMany({
          where: { role: 'owner' },
          include: { user: { select: { email: true } } },
        });
        return { org, emails: owners.map((o) => o.user.email) };
      });
      if (!notice) continue;
      const text = [
        `Telemetry for ${notice.org.name} reached a limit: new series were refused (${r.refusedSeriesRequests} requests) or samples were rate-limited (${r.refusedRateRequests} requests).`,
        'Existing series keep flowing; nothing was dropped silently. Agents retry refused data.',
        `Limits: ${INGEST_LIMITS.agentSeries.toLocaleString('en-US')} series per agent, ${INGEST_LIMITS.tenantSeries.toLocaleString('en-US')} per organization, ${INGEST_LIMITS.agentSamplesPerSecond.toLocaleString('en-US')} samples/s per agent.`,
        `Usage: ${this.config.appOrigin}/orgs/${notice.org.id}/usage`,
        'You get this at most once an hour.',
      ].join('\n\n');
      for (const to of notice.emails)
        await this.mailer.send({ to, subject: `Telemetry limit reached for ${notice.org.name}`, text });
    }
  }

  /** When refusals started within the last hour, or null (the dashboard warning). */
  async limitSince(ctx: TenantContext): Promise<Date | null> {
    const since = new Date(this.now().getTime() - HOUR_MS);
    const row = await withTenant(this.prisma, ctx, (tx) =>
      tx.telemetryUsage.findFirst({
        where: {
          minute: { gte: since },
          OR: [{ refusedSeriesRequests: { gt: 0 } }, { refusedRateRequests: { gt: 0 } }],
        },
        orderBy: { minute: 'asc' },
        select: { minute: true },
      }),
    );
    return row?.minute ?? null;
  }

  async view(ctx: TenantContext, range: UsageRange) {
    const now = this.now();
    const hours = USAGE_RANGES[range];
    const bucketMs = range === '24h' ? HOUR_MS : 24 * HOUR_MS;
    const from = new Date(now.getTime() - hours * HOUR_MS);
    const rows = await withTenant(this.prisma, ctx, (tx) =>
      tx.telemetryUsage.findMany({ where: { minute: { gte: from } }, orderBy: { minute: 'asc' } }),
    );
    const buckets = new Map<
      number,
      { start: Date; samples: number; activeSeries: number; refusedRequests: number }
    >();
    for (const r of rows) {
      const key = Math.floor(r.minute.getTime() / bucketMs) * bucketMs;
      const b = buckets.get(key) ?? { start: new Date(key), samples: 0, activeSeries: 0, refusedRequests: 0 };
      b.samples += Number(r.samples);
      b.activeSeries = Math.max(b.activeSeries, r.activeSeries);
      b.refusedRequests += r.refusedSeriesRequests + r.refusedRateRequests;
      buckets.set(key, b);
    }
    const series = [...buckets.values()];
    return {
      range,
      buckets: series,
      totals: {
        samples: series.reduce((n, b) => n + b.samples, 0),
        activeSeries: rows.at(-1)?.activeSeries ?? 0,
        refusedRequests: series.reduce((n, b) => n + b.refusedRequests, 0),
      },
      limits: INGEST_LIMITS,
      overLimitSince: await this.limitSince(ctx),
    };
  }
}
