import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import {
  SERVICE_LABEL,
  STATUS_TEXT,
  serviceStatus,
  type GoogleService,
  type ServiceStatus,
} from '@pcp/connectors-google';
import { aggregate, kpisFor, type TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { CLOCK, PRISMA } from '../../tokens.js';

export const KPI_RANGES = { '7d': 7, '28d': 28, '90d': 90 } as const;
export type KpiRange = keyof typeof KPI_RANGES;

/** Resource kinds with daily KPI values (M13b); Firebase apps are listed for the Mobile page. */
const KPI_RESOURCES = [
  'google_ga4_property',
  'google_search_console_site',
  'google_play_app',
  'google_firebase_app',
];
/** A sync runs hourly; two missed runs make the source stale. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export interface Freshness {
  lastSuccessfulSync: Date | null;
  lastAttempt: Date | null;
  expectedIntervalSeconds: number;
  status: 'current' | 'stale' | 'unavailable';
  reason: string | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Daily KPI values for one product (WB-09 UC-09-06): only resources scoped to it, every day of the
 * range present (missing days are null, never 0), and freshness per source (spec §11.3).
 */
@Injectable()
export class KpisService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  async forProduct(ctx: TenantContext, productId: string, range: KpiRange) {
    const today = this.now();
    const days = Array.from({ length: KPI_RANGES[range] }, (_, i) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - (KPI_RANGES[range] - 1 - i));
      return isoDay(d);
    });
    return withTenant(this.prisma, ctx, async (tx) => {
      const connections = await tx.connection.findMany({
        where: {
          provider: 'google',
          status: { notIn: ['disconnected', 'revoked'] },
          scopes: { some: { productId } },
        },
        include: { scopes: { where: { productId, resourceType: { in: KPI_RESOURCES } } } },
        orderBy: { createdAt: 'asc' },
      });
      const anyGoogle =
        connections.length > 0 ||
        (await tx.connection.count({
          where: { provider: 'google', status: { notIn: ['disconnected', 'revoked'] } },
        })) > 0;
      const resources = connections.flatMap((c) =>
        c.scopes.map((s) => ({
          connectionId: c.id,
          resourceType: s.resourceType,
          externalId: s.externalId,
          name: s.name,
        })),
      );
      const rows = resources.length
        ? await tx.metricAggregate.findMany({
            where: {
              connectionId: { in: connections.map((c) => c.id) },
              day: { gte: new Date(`${days[0]}T00:00:00Z`), lte: new Date(`${days.at(-1)}T00:00:00Z`) },
              OR: resources.map((r) => ({ resourceType: r.resourceType, externalId: r.externalId })),
            },
          })
        : [];

      const views = resources.map((r) => {
        const mine = rows.filter(
          (m) =>
            m.connectionId === r.connectionId &&
            m.resourceType === r.resourceType &&
            m.externalId === r.externalId,
        );
        const kpis = kpisFor(r.resourceType).map((def) => {
          const byDay = new Map(
            mine.filter((m) => m.metric === def.metric && m.dimension === '').map((m) => [isoDay(m.day), m]),
          );
          const points = days.map((d) => {
            const m = byDay.get(d);
            return { day: d, value: m?.value ?? null, completeness: m ? m.completeness : null };
          });
          return {
            key: def.key,
            label: def.label,
            unit: def.unit,
            definition: def.definition,
            caveats: def.caveats,
            ...(def.lowerIsBetter ? { lowerIsBetter: true } : {}),
            total: aggregate(
              def,
              points.map((p) => p.value),
            ),
            points,
          };
        });
        const channels = new Map<string, number>();
        for (const m of mine)
          if (m.metric === 'sessions' && m.dimension && m.value !== null)
            channels.set(m.dimension, (channels.get(m.dimension) ?? 0) + m.value);
        return {
          ...r,
          kpis,
          ...(r.resourceType === 'google_ga4_property'
            ? {
                breakdown: {
                  sessionsByChannel: [...channels]
                    .map(([channel, value]) => ({ channel, value }))
                    .sort((a, b) => b.value - a.value),
                },
              }
            : {}),
        };
      });

      const runs = connections.length
        ? await tx.syncRun.findMany({
            where: { connectionId: { in: connections.map((c) => c.id) }, kind: 'sync' },
            orderBy: { createdAt: 'desc' },
            take: 200,
          })
        : [];
      const gaps = new Set<string>();
      const connectionViews = connections.map((c) => {
        const services = serviceStatus(c.grantedScopes);
        for (const [s, status] of Object.entries(services) as Array<[GoogleService, ServiceStatus]>)
          if (status !== 'available') gaps.add(`${SERVICE_LABEL[s]}: ${STATUS_TEXT[status]}`);
        const mine = runs.filter((r) => r.connectionId === c.id);
        const success = mine.find((r) => r.status === 'succeeded');
        const latest = mine.find((r) => r.status === 'succeeded' || r.status === 'failed');
        const lastSuccessfulSync = success?.finishedAt ?? null;
        const failedLast = latest?.status === 'failed';
        const freshness: Freshness = {
          lastSuccessfulSync,
          lastAttempt: latest?.finishedAt ?? latest?.startedAt ?? null,
          expectedIntervalSeconds: 3600,
          status: !lastSuccessfulSync
            ? 'unavailable'
            : failedLast || today.getTime() - lastSuccessfulSync.getTime() > STALE_AFTER_MS
              ? 'stale'
              : 'current',
          reason: failedLast ? (latest?.errorMessage ?? latest?.errorCode ?? 'sync failed') : c.statusReason,
        };
        return {
          id: c.id,
          displayName: c.displayName,
          accountEmail: c.accountEmail,
          status: c.status,
          statusReason: c.statusReason,
          services,
          freshness,
        };
      });
      if (!anyGoogle) gaps.add('Google: not connected');
      return { range, days, connections: connectionViews, resources: views, gaps: [...gaps] };
    });
  }
}
