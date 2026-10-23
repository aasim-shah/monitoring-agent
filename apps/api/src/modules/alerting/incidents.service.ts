import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { acknowledge, createDeliveries, ingest, resolveManually, type NormalizedAlert } from '@pcp/alerting';
import type { Prisma, PrismaClient } from '@pcp/database';
import { enqueue, type Queues } from '@pcp/jobs';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { z } from 'zod';
import { ApiException, notFound } from '../../common/errors.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import type { incidentListQuery, postmortemBody } from './schemas.js';
import { ALERT_QUEUES } from './tokens.js';

type IncidentRow = Prisma.AlertIncidentGetPayload<object>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Labels the compiler adds to every alert: identity is the rule, not these. */
const COMPILER_LABELS = ['tenant_id', 'rule_id', 'severity', 'product_id'];

export interface AlertmanagerAlert {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
}

const view = (i: IncidentRow) => ({
  id: i.id,
  productId: i.productId,
  ruleId: i.ruleId,
  title: i.title,
  severity: i.severity,
  status: i.status,
  summary: i.summary,
  labels: i.labels,
  startedAt: i.startedAt,
  lastFiredAt: i.lastFiredAt,
  acknowledgedAt: i.acknowledgedAt,
  acknowledgedByUserId: i.acknowledgedByUserId,
  resolvedAt: i.resolvedAt,
  resolutionNote: i.resolutionNote,
  escalatedAt: i.escalatedAt,
  postmortem: i.postmortem,
});

/** Incident lifecycle and the Alertmanager-compatible receiver (WB-13 UC-13-02..08). */
@Injectable()
export class IncidentsService implements OnApplicationShutdown {
  private readonly logger = new Logger('Incidents');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(ALERT_QUEUES) private readonly queues: Queues,
    private readonly audit: AuditService,
  ) {}

  async onApplicationShutdown() {
    await this.queues.close();
  }

  /**
   * vmalert's notifications. The tenant comes from the compiler's labels and must own the rule
   * (Review Focus #1); anything else is dropped. Every tenant is ingested in its own context.
   */
  async receive(alerts: AlertmanagerAlert[]): Promise<{ accepted: number; dropped: number }> {
    const now = this.now();
    const byOrg = new Map<string, NormalizedAlert[]>();
    let dropped = 0;
    for (const a of alerts) {
      const labels = a.labels ?? {};
      const org = labels.tenant_id;
      const rule = labels.rule_id;
      if (!org || !rule || !UUID.test(org) || !UUID.test(rule)) {
        dropped++;
        continue;
      }
      const [owner] = await this.prisma.$queryRaw<{ org: string | null }[]>`
        SELECT pcp_resolve_alert_rule_org(${rule}::uuid)::text AS org`;
      if (owner?.org !== org) {
        this.logger.warn(`dropped alert: rule ${rule} does not belong to tenant ${org}`);
        dropped++;
        continue;
      }
      const ends = a.endsAt ? Date.parse(a.endsAt) : NaN;
      // vmalert sends a future endsAt while firing; Alertmanager's zero time means "not set".
      const resolved = Number.isFinite(ends) && ends > Date.UTC(2000, 0, 1) && ends <= now.getTime();
      const own = Object.fromEntries(Object.entries(labels).filter(([k]) => !COMPILER_LABELS.includes(k)));
      byOrg.set(org, [
        ...(byOrg.get(org) ?? []),
        {
          ruleId: rule,
          labels: own,
          status: resolved ? 'resolved' : 'firing',
          startsAt: a.startsAt && Number.isFinite(Date.parse(a.startsAt)) ? new Date(a.startsAt) : now,
          ...(resolved ? { endsAt: new Date(ends) } : {}),
          ...(a.annotations?.value ? { value: a.annotations.value } : {}),
        },
      ]);
    }
    let accepted = 0;
    for (const [org, list] of byOrg) {
      const ctx: TenantContext = {
        organizationId: org,
        actor: { kind: 'system', jobId: 'alert-receiver' },
        roles: ['owner'],
        productIds: 'all',
        environmentIds: 'all',
        requestId: randomUUID(),
      };
      const deliveries = await withTenant(this.prisma, ctx, async (tx) => {
        const result = await ingest(tx, org, list, now);
        return createDeliveries(tx, org, result.notify);
      });
      await this.queue(org, deliveries);
      accepted += list.length;
    }
    return { accepted, dropped };
  }

  async queue(organizationId: string, deliveryIds: string[]) {
    for (const id of deliveryIds)
      await enqueue(this.queues, 'notification-deliver', {
        organizationId,
        connectionId: id,
        requestId: `delivery-${id}`,
      });
  }

  async list(ctx: TenantContext, productId: string, status: z.output<typeof incidentListQuery>) {
    const where: Prisma.AlertIncidentWhereInput = { productId };
    if (status === 'active') where.status = { in: ['open', 'acknowledged'] };
    else if (status !== 'all') where.status = status;
    const rows = await withTenant(this.prisma, ctx, (tx) =>
      tx.alertIncident.findMany({ where, orderBy: { startedAt: 'desc' }, take: 100 }),
    );
    return { incidents: rows.map(view) };
  }

  async detail(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const incident = await tx.alertIncident.findUnique({ where: { id } });
      if (!incident) throw notFound();
      const events = await tx.incidentEvent.findMany({
        where: { incidentId: id },
        orderBy: { at: 'asc' },
        select: { kind: true, detail: true, at: true },
      });
      const labels = incident.labels as Record<string, string>;
      const correlation = incident.correlation as {
        host?: { id: string; name: string } | null;
        assets?: unknown[];
        counts?: Record<string, number>;
      };
      const base = `/orgs/${ctx.organizationId}/products/${incident.productId}`;
      const sourceLinks: Array<{ label: string; href: string }> = [];
      if (labels.agent_id && UUID.test(labels.agent_id)) {
        const agent = await tx.agent.findUnique({
          where: { id: labels.agent_id },
          select: { hostname: true },
        });
        if (agent)
          sourceLinks.push({
            label: `Server ${agent.hostname}`,
            href: `${base}/infrastructure/${labels.agent_id}`,
          });
      }
      if (correlation.host)
        sourceLinks.push({
          label: `Asset ${correlation.host.name}`,
          href: `${base}/assets/${correlation.host.id}`,
        });
      sourceLinks.push({ label: 'Alert rules', href: `${base}/alert-rules` });
      return {
        incident: view(incident),
        events,
        correlation: {
          host: correlation.host ?? null,
          assets: correlation.assets ?? [],
          counts: correlation.counts ?? {},
        },
        // Change sources (deployments) arrive with M7; until then there are none to show.
        changes: [],
        sourceLinks,
      };
    });
  }

  async acknowledge(ctx: TenantContext, id: string) {
    const userId = this.userId(ctx);
    await withTenant(this.prisma, ctx, async (tx) => {
      try {
        await acknowledge(tx, id, userId, this.now());
      } catch {
        throw new ApiException(409, 'not_open', 'Only an open incident can be acknowledged');
      }
      await this.audit.record(tx, ctx, {
        action: 'incident.acknowledge',
        targetType: 'incident',
        targetId: id,
      });
    });
    return this.detail(ctx, id);
  }

  async resolve(ctx: TenantContext, id: string, note: string | undefined) {
    const userId = this.userId(ctx);
    await withTenant(this.prisma, ctx, async (tx) => {
      try {
        await resolveManually(tx, id, userId, note || 'Resolved manually', this.now());
      } catch {
        throw new ApiException(409, 'already_resolved', 'This incident is already resolved');
      }
      await this.audit.record(tx, ctx, { action: 'incident.resolve', targetType: 'incident', targetId: id });
    });
    return this.detail(ctx, id);
  }

  async postmortem(ctx: TenantContext, id: string, body: z.output<typeof postmortemBody>) {
    await withTenant(this.prisma, ctx, async (tx) => {
      const { count } = await tx.alertIncident.updateMany({
        where: { id },
        data: { postmortem: { ...body, updatedAt: this.now().toISOString() } },
      });
      if (!count) throw notFound();
      await this.audit.record(tx, ctx, {
        action: 'incident.postmortem',
        targetType: 'incident',
        targetId: id,
        metadata: { causeCategory: body.causeCategory },
      });
    });
    return this.detail(ctx, id);
  }

  private userId(ctx: TenantContext): string {
    if (ctx.actor.kind !== 'user') throw notFound();
    return ctx.actor.userId;
  }
}
