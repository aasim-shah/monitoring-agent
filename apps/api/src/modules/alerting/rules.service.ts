import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RECOMMENDED,
  TEMPLATES,
  compileTenant,
  isTemplateId,
  resolveManually,
  validateParams,
  type Params,
  type TemplateId,
} from '@pcp/alerting';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { ApiException, notFound } from '../../common/errors.js';
import { APP_CONFIG, CLOCK, PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import { reloadVmalert, writeTenantRules } from './rule-files.js';
import type { createRuleBody, updateRuleBody } from './schemas.js';

type Tx = Prisma.TransactionClient;
type RuleRow = Prisma.AlertRuleGetPayload<object>;

const ALERT_TICK_SECONDS = 60;

const view = (r: RuleRow) => ({
  id: r.id,
  productId: r.productId,
  name: r.name,
  template: r.template,
  params: r.params,
  severity: r.severity,
  enabled: r.enabled,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

function params(template: TemplateId, input: Record<string, unknown>): Params {
  try {
    return validateParams(template, input);
  } catch (err) {
    throw new ApiException(400, 'invalid_params', (err as Error).message);
  }
}

/** Alert rules from templates (WB-13 UC-13-01); each change recompiles the tenant's vmalert file. */
@Injectable()
export class RulesService {
  private readonly logger = new Logger('AlertRules');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly audit: AuditService,
  ) {}

  templates() {
    return Object.values(TEMPLATES).map(({ expr: _, ...t }) => t);
  }

  async list(ctx: TenantContext, productId: string) {
    const rules = await withTenant(this.prisma, ctx, (tx) =>
      tx.alertRule.findMany({ where: { productId, archivedAt: null }, orderBy: { createdAt: 'asc' } }),
    );
    return { rules: rules.map(view), templates: this.templates() };
  }

  async create(ctx: TenantContext, productId: string, body: z.output<typeof createRuleBody>) {
    if (!isTemplateId(body.template))
      throw new ApiException(400, 'invalid_template', `Unknown rule template ${body.template}`);
    const template = body.template;
    const p = params(template, body.params ?? {});
    const rule = await withTenant(this.prisma, ctx, async (tx) => {
      const created = await this.insert(tx, ctx, productId, template, p, body);
      await this.audit.record(tx, ctx, {
        action: 'alert_rule.create',
        targetType: 'alert_rule',
        targetId: created.id,
        metadata: { template, productId },
      });
      return created;
    });
    await this.sync(ctx);
    return view(rule);
  }

  /** Adds the recommended rules the product does not have yet (idempotent). */
  async recommended(ctx: TenantContext, productId: string) {
    await withTenant(this.prisma, ctx, async (tx) => {
      const have = new Set(
        (
          await tx.alertRule.findMany({ where: { productId, archivedAt: null }, select: { template: true } })
        ).map((r) => r.template),
      );
      const missing = RECOMMENDED.filter((t) => !have.has(t));
      for (const t of missing) await this.insert(tx, ctx, productId, t, params(t, {}), {});
      if (missing.length)
        await this.audit.record(tx, ctx, {
          action: 'alert_rule.recommended',
          targetType: 'product',
          targetId: productId,
          metadata: { templates: missing },
        });
    });
    await this.sync(ctx);
    return this.list(ctx, productId);
  }

  async update(ctx: TenantContext, id: string, body: z.output<typeof updateRuleBody>) {
    const rule = await withTenant(this.prisma, ctx, async (tx) => {
      const current = await tx.alertRule.findUnique({ where: { id } });
      if (!current || current.archivedAt) throw notFound();
      const updated = await tx.alertRule.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.severity !== undefined ? { severity: body.severity } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.params !== undefined
            ? {
                params: params(current.template as TemplateId, {
                  ...(current.params as Record<string, unknown>),
                  ...body.params,
                }),
              }
            : {}),
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'alert_rule.update',
        targetType: 'alert_rule',
        targetId: id,
        metadata: { changes: Object.keys(body) },
      });
      return updated;
    });
    await this.sync(ctx);
    return view(rule);
  }

  /**
   * Deleting archives the rule: it stops evaluating and leaves the list, while its incidents
   * (history, postmortems) stay. Open incidents of the rule are resolved with a note.
   */
  async remove(ctx: TenantContext, id: string) {
    const now = this.now();
    await withTenant(this.prisma, ctx, async (tx) => {
      const { count } = await tx.alertRule.updateMany({
        where: { id, archivedAt: null },
        data: { archivedAt: now, enabled: false },
      });
      if (!count) throw notFound();
      const open = await tx.alertIncident.findMany({
        where: { ruleId: id, status: { not: 'resolved' } },
        select: { id: true },
      });
      const userId = ctx.actor.kind === 'user' ? ctx.actor.userId : 'system';
      for (const i of open) await resolveManually(tx, i.id, userId, 'Alert rule deleted', now);
      await this.audit.record(tx, ctx, {
        action: 'alert_rule.delete',
        targetType: 'alert_rule',
        targetId: id,
      });
    });
    await this.sync(ctx);
  }

  private insert(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    template: TemplateId,
    p: Params,
    body: { name?: string; severity?: RuleRow['severity']; enabled?: boolean },
  ) {
    return tx.alertRule.create({
      data: {
        organizationId: ctx.organizationId,
        productId,
        name: body.name ?? TEMPLATES[template].label,
        template,
        params: p,
        severity: body.severity ?? TEMPLATES[template].defaultSeverity,
        enabled: body.enabled ?? true,
        createdByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
      },
    });
  }

  /**
   * Rewrites the tenant's vmalert file from all of its rules, asks vmalert to reload, and keeps
   * the worker's per-tenant alert tick scheduled while any rule is enabled. Reads every rule
   * of the organization (a system view of the tenant), not just the caller's products.
   */
  private async sync(ctx: TenantContext) {
    const system: TenantContext = { ...ctx, productIds: 'all' };
    const rules = await withTenant(this.prisma, system, async (tx) => {
      const all = await tx.alertRule.findMany({ where: { archivedAt: null }, orderBy: { createdAt: 'asc' } });
      const enabled = all.some((r) => r.enabled);
      await tx.jobDefinition.upsert({
        where: {
          organizationId_kind_entityId: {
            organizationId: ctx.organizationId,
            kind: 'alert-tick',
            entityId: ctx.organizationId,
          },
        },
        create: {
          organizationId: ctx.organizationId,
          kind: 'alert-tick',
          entityId: ctx.organizationId,
          everySeconds: ALERT_TICK_SECONDS,
          enabled,
        },
        update: { enabled },
      });
      return all;
    });
    const { alertRulesDir: dir, vmalertUrl: url } = this.config;
    if (!dir) return;
    const yaml = compileTenant(
      ctx.organizationId,
      rules
        .filter((r) => isTemplateId(r.template))
        .map((r) => ({
          id: r.id,
          productId: r.productId,
          name: r.name,
          template: r.template as TemplateId,
          params: r.params as Params,
          severity: r.severity,
          enabled: r.enabled,
        })),
    );
    await writeTenantRules(dir, ctx.organizationId, yaml);
    if (url && !(await reloadVmalert(url)))
      this.logger.warn('vmalert reload failed; it re-reads rule files every minute');
  }
}
