import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { assertPublicDestination } from '@pcp/connector-sdk';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { verifyDomain, type ResolveTxt } from '@pcp/website-probe';
import { ApiException, notFound } from '../../common/errors.js';
import { CLOCK, DNS_RESOLVER, PRISMA, TXT_RESOLVER } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import type { DnsResolver } from '../discovery/discovery.service.js';

/** Master plan §3 / WB-09 BR-09-02. */
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_MONITORS_PER_ORG = 50;

type MonitorRow = Prisma.WebsiteMonitorGetPayload<object>;

export const monitorView = (m: MonitorRow) => ({
  id: m.id,
  productId: m.productId,
  url: m.url,
  host: m.host,
  intervalSeconds: m.intervalSeconds,
  expectedStatus: m.expectedStatus,
  status: m.status,
  pausedReason: m.pausedReason,
  verifiedAt: m.verifiedAt,
  verification: { record: 'TXT' as const, name: m.host, value: `pcp-verify=${m.verifyToken}` },
  last: m.lastCheckedAt
    ? {
        checkedAt: m.lastCheckedAt,
        up: m.lastUp,
        statusCode: m.lastStatusCode,
        error: m.lastError,
        totalMs: m.lastTotalMs,
        consecutiveFailures: m.consecutiveFailures,
      }
    : null,
  tls: m.tlsExpiresAt ? { expiresAt: m.tlsExpiresAt, issuer: m.tlsIssuer } : null,
  createdAt: m.createdAt,
});

/** Website monitors (WB-09 UC-09-01/02): public targets only, probed after DNS TXT verification. */
@Injectable()
export class WebsitesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(TXT_RESOLVER) private readonly txt: ResolveTxt,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext, productId: string) {
    const rows = await withTenant(this.prisma, ctx, (tx) =>
      tx.websiteMonitor.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } }),
    );
    return { monitors: rows.map(monitorView) };
  }

  async create(
    ctx: TenantContext,
    productId: string,
    input: { url: string; intervalSeconds: number; expectedStatus?: number | null },
  ) {
    const url = await this.checkUrl(input.url);
    const row = await withTenant(this.prisma, ctx, async (tx) => {
      if ((await tx.websiteMonitor.count()) >= MAX_MONITORS_PER_ORG)
        throw new ApiException(
          409,
          'limit_reached',
          `At most ${MAX_MONITORS_PER_ORG} website monitors per organization`,
        );
      if (await tx.websiteMonitor.findFirst({ where: { url: url.toString() }, select: { id: true } }))
        throw new ApiException(409, 'already_monitored', 'This URL is already monitored');
      const m = await tx.websiteMonitor.create({
        data: {
          organizationId: ctx.organizationId,
          productId,
          url: url.toString(),
          host: url.hostname,
          intervalSeconds: input.intervalSeconds,
          expectedStatus: input.expectedStatus ?? null,
          verifyToken: randomBytes(18).toString('base64url'),
          createdByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
        },
      });
      // The worker probes on this schedule; unverified monitors only check the TXT record.
      await tx.jobDefinition.create({
        data: {
          organizationId: ctx.organizationId,
          kind: 'website-probe',
          entityId: m.id,
          everySeconds: m.intervalSeconds,
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'website_monitor.create',
        targetType: 'website_monitor',
        targetId: m.id,
        metadata: { url: m.url },
      });
      return m;
    });
    return monitorView(row);
  }

  /** Checks the TXT record now (UC-09-01). */
  async verify(ctx: TenantContext, id: string) {
    const m = await withTenant(this.prisma, ctx, (tx) => tx.websiteMonitor.findUnique({ where: { id } }));
    if (!m) throw notFound();
    const result = await verifyDomain(m.host, m.verifyToken, this.txt);
    const now = this.now();
    await withTenant(this.prisma, ctx, async (tx) => {
      await tx.websiteMonitor.update({
        where: { id },
        data: result.verified
          ? { status: 'active', verifiedAt: now, verificationCheckedAt: now, pausedReason: null }
          : { verificationCheckedAt: now },
      });
      await this.audit.record(tx, ctx, {
        action: 'website_monitor.verify',
        targetType: 'website_monitor',
        targetId: id,
        metadata: { verified: result.verified },
      });
    });
    return result;
  }

  async remove(ctx: TenantContext, id: string) {
    await withTenant(this.prisma, ctx, async (tx) => {
      const { count } = await tx.websiteMonitor.deleteMany({ where: { id } });
      if (!count) throw notFound();
      await tx.jobDefinition.deleteMany({ where: { kind: 'website-probe', entityId: id } });
      await this.audit.record(tx, ctx, {
        action: 'website_monitor.delete',
        targetType: 'website_monitor',
        targetId: id,
      });
    });
  }

  /** http(s) to a public address only (Review Focus #1); the worker checks again at every probe. */
  private async checkUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ApiException(400, 'invalid_url', 'Enter a full URL such as https://shop.example.com');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new ApiException(400, 'invalid_url', 'Only http:// and https:// URLs can be monitored');
    try {
      await assertPublicDestination(url, {
        allowPrivate: false,
        lookup: async (host) =>
          (await this.dns(host)).map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 })),
      });
    } catch (err) {
      throw new ApiException(400, 'destination_blocked', (err as Error).message);
    }
    return url;
  }
}
