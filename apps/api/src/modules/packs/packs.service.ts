import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException, notFound, parseBody } from '../../common/errors.js';
import type { AgentIdentity } from '../../common/request.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { TasksService } from '../agents/tasks.service.js';
import { AuditService } from '../auditing/audit.service.js';
import { packById } from './catalog.js';
import type { configAckBody, enablePackBody } from './schemas.js';
import type { z } from 'zod';

type Assignment = Prisma.AgentPackAssignmentGetPayload<object>;

/** What the dashboard sees of an assignment: never the ciphertext (BR-11-03). */
const view = (a: Assignment) => ({
  packId: a.packId,
  settings: a.settings,
  status: a.status,
  statusMessage: a.statusMessage,
  policyVersion: a.policyVersion,
  appliedAt: a.appliedAt,
  updatedAt: a.updatedAt,
  retainLogs: a.retainLogs,
  // Data inspection settings (M18.2): which keys and topics an owner allowlisted.
  inspection: {
    enabled: (a.inspection as { enabled?: boolean } | null)?.enabled === true,
    redisKeys: (a.inspection as { redisKeys?: string[] } | null)?.redisKeys ?? [],
    peekTopics: (a.inspection as { peekTopics?: string[] } | null)?.peekTopics ?? [],
  },
});

interface InventoryService {
  pack: string;
}

/** Monitoring pack assignments and the agent's configuration channel (WB-11, D24). */
/** The scrape pack each managed exporter feeds, and where the exporter listens (M18.3). */
const EXPORTER_PACKS: Record<string, { packId: string; endpoint: string }> = {
  redis_exporter: { packId: 'redis-exporter', endpoint: '127.0.0.1:9121' },
  kafka_exporter: { packId: 'kafka-exporter', endpoint: '127.0.0.1:9308' },
};

@Injectable()
export class PacksService implements OnModuleInit {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
  ) {}

  /** After pcp-helper installs or removes a Level 1 exporter, start or stop scraping it. */
  onModuleInit() {
    this.tasks.onResult(async (ctx, _agent, task, body) => {
      const capability = task.payload.capability;
      if (task.type !== 'action' || body.status !== 'succeeded') return;
      if (capability !== 'pack_install' && capability !== 'pack_remove') return;
      const target = EXPORTER_PACKS[String(task.payload.exporter)];
      if (!target) return;
      const agentId = (await withTenant(this.prisma, ctx, (tx) =>
        tx.agentTask.findUnique({ where: { id: task.id }, select: { agentId: true } }),
      ))!.agentId;
      if (capability === 'pack_install')
        await this.enable(ctx, agentId, { packId: target.packId, settings: { endpoint: target.endpoint } });
      else await this.disable(ctx, agentId, target.packId).catch(() => undefined);
    });
  }

  /** Bumps the agent's policy version; the row lock serializes concurrent changes to one agent. */
  private async bump(tx: Prisma.TransactionClient, agentId: string): Promise<number> {
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { status: true } });
    if (!agent) throw notFound();
    if (agent.status === 'revoked') throw new ApiException(409, 'agent_revoked', 'This agent is revoked');
    const { policyVersion } = await tx.agent.update({
      where: { id: agentId },
      data: { policyVersion: { increment: 1 } },
      select: { policyVersion: true },
    });
    return policyVersion;
  }

  list(ctx: TenantContext, agentId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const rows = await tx.agentPackAssignment.findMany({
        where: { agentId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(view);
    });
  }

  enable(ctx: TenantContext, agentId: string, body: z.output<typeof enablePackBody>) {
    const pack = packById(body.packId);
    if (!pack) throw new ApiException(400, 'unknown_pack', `Unknown pack: ${body.packId}`);
    const settings = parseBody(pack.settings, body.settings) as Prisma.InputJsonValue;
    const userId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
    return withTenant(this.prisma, ctx, async (tx) => {
      const policyVersion = await this.bump(tx, agentId);
      const existing = await tx.agentPackAssignment.findUnique({
        where: { agentId_packId: { agentId, packId: pack.id } },
        select: { id: true },
      });
      const fields = {
        settings,
        status: 'pending' as const,
        statusMessage: null,
        policyVersion,
        // Without new ciphertext the agent keeps the credentials it already holds.
        ...(body.sealedCredentials ? { sealedCredentials: body.sealedCredentials } : {}),
      };
      const row = existing
        ? await tx.agentPackAssignment.update({ where: { id: existing.id }, data: fields })
        : await tx.agentPackAssignment.create({
            data: {
              ...fields,
              organizationId: ctx.organizationId,
              agentId,
              packId: pack.id,
              createdByUserId: userId,
            },
          });
      await this.audit.record(tx, ctx, {
        action: existing ? 'pack.updated' : 'pack.enabled',
        targetType: 'agent',
        targetId: agentId,
        metadata: { packId: pack.id, credentialsProvided: !!body.sealedCredentials },
      });
      return { created: !existing, assignment: view(row) };
    });
  }

  disable(ctx: TenantContext, agentId: string, packId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const existing = await tx.agentPackAssignment.findUnique({
        where: { agentId_packId: { agentId, packId } },
      });
      if (!existing || existing.status === 'removing') throw notFound();
      const policyVersion = await this.bump(tx, agentId);
      await tx.agentPackAssignment.update({
        where: { id: existing.id },
        data: { status: 'removing', statusMessage: null, sealedCredentials: null, policyVersion },
      });
      await this.audit.record(tx, ctx, {
        action: 'pack.disabled',
        targetType: 'agent',
        targetId: agentId,
        metadata: { packId },
      });
      return { status: 'removing' as const };
    });
  }

  /** Retained logs opt-in for one pack (M18.1): the agent reconfigures on its next heartbeat. */
  setRetainLogs(ctx: TenantContext, agentId: string, packId: string, enabled: boolean) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const existing = await tx.agentPackAssignment.findUnique({
        where: { agentId_packId: { agentId, packId } },
      });
      if (!existing || existing.status === 'removing') throw notFound();
      if (existing.retainLogs === enabled) return view(existing);
      const policyVersion = await this.bump(tx, agentId);
      const row = await tx.agentPackAssignment.update({
        where: { id: existing.id },
        data: { retainLogs: enabled, status: 'pending', statusMessage: null, policyVersion },
      });
      await this.audit.record(tx, ctx, {
        action: 'pack.retained_logs',
        targetType: 'agent',
        targetId: agentId,
        metadata: { packId, enabled },
      });
      return view(row);
    });
  }

  inventory(ctx: TenantContext, agentId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const agent = await tx.agent.findUnique({
        where: { id: agentId },
        select: { inventory: true, packs: { select: { packId: true } } },
      });
      if (!agent) throw notFound();
      const inv = agent.inventory;
      if (!inv) return { inventory: null, suggestedPacks: [] };
      const enabled = new Set(agent.packs.map((p) => p.packId));
      const detected = (inv.services as unknown as InventoryService[]).map((s) => s.pack);
      return {
        inventory: {
          collectedAt: inv.collectedAt,
          services: inv.services,
          listeners: inv.listeners,
          warnings: inv.warnings,
        },
        suggestedPacks: [...new Set(detected)].filter((p) => packById(p) && !enabled.has(p)),
      };
    });
  }

  // Agent side (mTLS control channel until OpAMP, D13).

  saveInventory(
    ctx: TenantContext,
    agent: AgentIdentity,
    inv: { collectedAt: string; services: unknown; listeners: unknown; warnings: unknown },
  ) {
    const data = {
      collectedAt: new Date(inv.collectedAt),
      services: inv.services as Prisma.InputJsonValue,
      listeners: inv.listeners as Prisma.InputJsonValue,
      warnings: inv.warnings as Prisma.InputJsonValue,
    };
    return withTenant(this.prisma, ctx, (tx) =>
      tx.agentInventory.upsert({
        where: { agentId: agent.id },
        create: { ...data, agentId: agent.id, organizationId: agent.organizationId },
        update: data,
        select: { agentId: true },
      }),
    );
  }

  config(ctx: TenantContext, agent: AgentIdentity) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const { policyVersion } = await tx.agent.findUniqueOrThrow({
        where: { id: agent.id },
        select: { policyVersion: true },
      });
      const rows = await tx.agentPackAssignment.findMany({
        where: { agentId: agent.id, status: { not: 'removing' } },
        orderBy: { createdAt: 'asc' },
      });
      return {
        policyVersion,
        packs: rows.map((r) => ({
          packId: r.packId,
          settings: r.settings,
          ...(r.sealedCredentials ? { sealedCredentials: r.sealedCredentials } : {}),
          ...(r.retainLogs ? { retainLogs: true } : {}),
        })),
      };
    });
  }

  /**
   * The agent applied (or failed to apply) configuration `policyVersion`. Only assignments
   * changed at or before that version are settled, so a change made meanwhile stays pending
   * with its ciphertext. Ciphertext is deleted on any ack: the agent has opened it.
   */
  ack(ctx: TenantContext, agent: AgentIdentity, body: z.output<typeof configAckBody>) {
    const now = this.now();
    return withTenant(this.prisma, ctx, async (tx) => {
      const settled = { agentId: agent.id, policyVersion: { lte: body.policyVersion } };
      for (const r of body.results) {
        await tx.agentPackAssignment.updateMany({
          where: { ...settled, packId: r.packId, status: { not: 'removing' } },
          data: {
            status: r.status,
            statusMessage:
              r.status === 'failed' ? (r.message ?? 'The agent could not apply this pack') : null,
            sealedCredentials: null,
            ...(r.status === 'applied' ? { appliedAt: now } : {}),
          },
        });
      }
      await tx.agentPackAssignment.deleteMany({ where: { ...settled, status: 'removing' } });
    });
  }
}
