import type { DestinationOptions } from '@pcp/connector-sdk';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { probe, verifyDomain, type ProbeResult, type ResolveTxt } from '@pcp/website-probe';

export interface WebsiteDeps {
  prisma: PrismaClient;
  now(): Date;
  resolveTxt: ResolveTxt;
  destination: DestinationOptions;
  /** VictoriaMetrics base URL for samples; unset writes none. */
  vmImportUrl?: string;
}

const VERIFY_WINDOW_MS = 24 * 3600_000;
const REVERIFY_AFTER_MS = 30 * 86400_000;

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Prometheus text lines for one probe; nothing is written for a probe that did not run. */
function samples(labels: Record<string, string>, r: ProbeResult, at: Date): string {
  const l = Object.entries(labels)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(',');
  const ts = at.getTime();
  const lines = [`website_up{${l}} ${r.up ? 1 : 0} ${ts}`, `website_redirects{${l}} ${r.redirects} ${ts}`];
  if (r.statusCode !== null) lines.push(`website_status_code{${l}} ${r.statusCode} ${ts}`);
  if (r.statusCode !== null) lines.push(`website_response_seconds{${l}} ${r.totalMs / 1000} ${ts}`);
  if (r.ttfbMs !== null) lines.push(`website_ttfb_seconds{${l}} ${r.ttfbMs / 1000} ${ts}`);
  if (r.tls)
    lines.push(`website_tls_expiry_days{${l}} ${(r.tls.expiresAt.getTime() - ts) / 86400_000} ${ts}`);
  return lines.join('\n') + '\n';
}

/**
 * The `website-probe` job (WB-09 UC-09-01/03): unverified domains are only checked for the TXT
 * record (never probed); verified ones are probed, the result is kept on the monitor for alerts
 * and the UI, and samples go to VictoriaMetrics with tenant, product, and monitor labels.
 */
export function websiteProbeHandler(deps: WebsiteDeps) {
  return async (ctx: TenantContext, monitorId: string) => {
    const now = deps.now();
    const m = await withTenant(deps.prisma, ctx, (tx) =>
      tx.websiteMonitor.findUnique({ where: { id: monitorId } }),
    );
    if (!m) return { skipped: 'monitor not found' };
    const update = (data: Parameters<PrismaClient['websiteMonitor']['update']>[0]['data']) =>
      withTenant(deps.prisma, ctx, (tx) => tx.websiteMonitor.update({ where: { id: m.id }, data }));

    if (m.status === 'paused') return { skipped: 'paused' };
    if (m.status === 'pending_verification') {
      if (now.getTime() - m.createdAt.getTime() > VERIFY_WINDOW_MS) {
        await update({ status: 'paused', pausedReason: 'Domain verification timed out after 24 hours' });
        return { skipped: 'verification timed out' };
      }
      const v = await verifyDomain(m.host, m.verifyToken, deps.resolveTxt);
      if (!v.verified) {
        await update({ verificationCheckedAt: now });
        return { skipped: 'domain not verified' };
      }
      await update({ status: 'active', verifiedAt: now, verificationCheckedAt: now, pausedReason: null });
    } else if (m.verifiedAt && now.getTime() - m.verifiedAt.getTime() > REVERIFY_AFTER_MS) {
      const v = await verifyDomain(m.host, m.verifyToken, deps.resolveTxt);
      if (!v.verified) {
        await update({
          status: 'paused',
          verificationCheckedAt: now,
          pausedReason: `Re-verification failed: the TXT record pcp-verify=${m.verifyToken} was not found on ${v.checkedNames.join(' or ')}`,
        });
        return { skipped: 'verification failed' };
      }
      await update({ verifiedAt: now, verificationCheckedAt: now });
    }

    const r = await probe(m.url, { destination: deps.destination, now, expectedStatus: m.expectedStatus });
    await update({
      lastCheckedAt: now,
      lastUp: r.up,
      lastStatusCode: r.statusCode,
      lastError: r.error ?? null,
      lastTotalMs: r.totalMs,
      consecutiveFailures: r.up ? 0 : m.consecutiveFailures + 1,
      ...(r.tls ? { tlsExpiresAt: r.tls.expiresAt, tlsIssuer: r.tls.issuer } : {}),
    });
    if (deps.vmImportUrl) {
      const body = samples(
        { tenant_id: m.organizationId, product_id: m.productId, monitor_id: m.id },
        r,
        now,
      );
      await fetch(`${deps.vmImportUrl}/api/v1/import/prometheus`, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    return { up: r.up, statusCode: r.statusCode, totalMs: r.totalMs };
  };
}
