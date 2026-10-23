import { Inject, Injectable } from '@nestjs/common';
import { runInvestigation, type ChatMessage, type ChatProvider, type Evidence } from '@pcp/ai-orchestrator';
import type { Prisma, PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../../config.js';
import { ApiException, notFound } from '../../common/errors.js';
import { APP_CONFIG, CLOCK, PRISMA } from '../../tokens.js';
import { AssetsService } from '../assets/assets.service.js';
import { AuditService } from '../auditing/audit.service.js';
import { SseWriter } from '../logs/sse-writer.js';
import { TelemetryQueryService } from '../telemetry/query.service.js';
import { buildProvider } from './provider.factory.js';
import { AI_TOOLS } from './tools.js';

/** Conversations are listed for 90 days (master plan §3). */
const RETENTION_MS = 90 * 86400_000;
const HISTORY_MESSAGES = 10;

/** What the browser sees of an evidence item: never more than the model saw. */
const evidenceView = (e: Evidence) => ({
  id: e.id,
  tool: e.tool,
  input: e.input,
  status: e.status,
  gaps: e.gaps,
  sources: e.sources,
  data: JSON.parse(e.json).data ?? null,
});

/** The AI assistant (spec §12, WB-14): settings, conversations, and streamed investigations. */
@Injectable()
export class AiService {
  private readonly provider: ChatProvider | null;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly assets: AssetsService,
    private readonly telemetry: TelemetryQueryService,
    private readonly audit: AuditService,
  ) {
    this.provider = buildProvider(config);
  }

  async settings(ctx: TenantContext) {
    const row = await withTenant(this.prisma, ctx, (tx) =>
      tx.aiSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
    );
    return {
      disabled: row?.disabled ?? false,
      available: this.provider !== null,
      provider: this.provider?.id ?? null,
      model: this.provider?.model ?? null,
    };
  }

  async updateSettings(ctx: TenantContext, disabled: boolean) {
    await withTenant(this.prisma, ctx, async (tx) => {
      await tx.aiSettings.upsert({
        where: { organizationId: ctx.organizationId },
        create: { organizationId: ctx.organizationId, disabled, updatedByUserId: this.userId(ctx) },
        update: { disabled, updatedByUserId: this.userId(ctx) },
      });
      await this.audit.record(tx, ctx, {
        action: 'ai.settings_update',
        targetType: 'organization',
        targetId: ctx.organizationId,
        metadata: { disabled },
      });
    });
    return this.settings(ctx);
  }

  /** 409 when AI is off for the organization or no provider is configured (BR-14-09). */
  private async requireEnabled(ctx: TenantContext): Promise<ChatProvider> {
    const s = await this.settings(ctx);
    if (s.disabled)
      throw new ApiException(409, 'ai_disabled', 'The AI assistant is turned off for this organization');
    if (!this.provider)
      throw new ApiException(409, 'ai_unavailable', 'No AI provider is configured on this platform');
    return this.provider;
  }

  async createConversation(ctx: TenantContext, productId: string, title: string) {
    await this.requireEnabled(ctx);
    return withTenant(this.prisma, ctx, (tx) =>
      tx.aiConversation.create({
        data: {
          organizationId: ctx.organizationId,
          productId,
          title: title.slice(0, 120) || 'New conversation',
          createdByUserId: this.userId(ctx),
        },
        select: { id: true, title: true, createdAt: true },
      }),
    );
  }

  async listConversations(ctx: TenantContext, productId: string) {
    const rows = await withTenant(this.prisma, ctx, (tx) =>
      tx.aiConversation.findMany({
        where: {
          productId,
          createdByUserId: this.userId(ctx),
          updatedAt: { gt: new Date(this.now().getTime() - RETENTION_MS) },
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: { id: true, title: true, updatedAt: true },
      }),
    );
    return { conversations: rows };
  }

  async conversation(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const c = await tx.aiConversation.findUnique({
        where: { id },
        select: { id: true, title: true, productId: true },
      });
      if (!c) throw notFound();
      const messages = await tx.aiMessage.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          content: true,
          evidence: true,
          missing: true,
          confidence: true,
          validation: true,
          createdAt: true,
        },
      });
      return { ...c, messages };
    });
  }

  /**
   * Streams one investigation as server-sent events: `tool` (started and finished), `answer`,
   * and `done`. Messages, the run, and every tool call are stored; denied tool calls are audited.
   */
  async ask(ctx: TenantContext, conversationId: string, content: string, reply: FastifyReply) {
    const provider = await this.requireEnabled(ctx);
    const setup = await withTenant(this.prisma, ctx, async (tx) => {
      const c = await tx.aiConversation.findUnique({
        where: { id: conversationId },
        select: { productId: true, product: { select: { name: true } } },
      });
      if (!c) throw notFound();
      const org = await tx.organization.findUnique({
        where: { id: ctx.organizationId },
        select: { timezone: true },
      });
      const previous = await tx.aiMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_MESSAGES,
        select: { role: true, content: true },
      });
      await tx.aiMessage.create({
        data: { organizationId: ctx.organizationId, conversationId, role: 'user', content },
      });
      const run = await tx.aiRun.create({
        data: {
          organizationId: ctx.organizationId,
          conversationId,
          provider: provider.id,
          model: provider.model,
        },
        select: { id: true },
      });
      return { ...c, timezone: org?.timezone ?? 'UTC', previous: previous.reverse(), runId: run.id };
    });

    const out = new SseWriter(reply.raw);
    reply.hijack();
    out.open(
      {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      () => {},
      { event: 'started', data: { runId: setup.runId } },
    );

    const result = await runInvestigation({
      provider,
      tools: AI_TOOLS,
      ctx,
      question: content,
      history: setup.previous.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      productName: setup.product.name,
      timezone: setup.timezone,
      now: this.now(),
      deps: {
        prisma: this.prisma,
        assets: this.assets,
        telemetry: this.telemetry,
        productId: setup.productId,
        orgId: ctx.organizationId,
        now: this.now,
      },
      onEvent: (e) => {
        if (e.type === 'tool_started')
          out.event('tool', { tool: e.tool, evidenceId: e.evidenceId, status: 'running' });
        if (e.type === 'tool_finished')
          out.event('tool', { tool: e.evidence.tool, evidenceId: e.evidence.id, status: e.evidence.status });
      },
    });

    const evidence = result.evidence.map(evidenceView);
    await withTenant(this.prisma, ctx, async (tx) => {
      for (const e of result.evidence) {
        await tx.aiToolExecution.create({
          data: {
            organizationId: ctx.organizationId,
            runId: setup.runId,
            tool: e.tool,
            input: e.input as Prisma.InputJsonValue,
            status: e.status,
            evidenceId: e.id,
            durationMs: e.durationMs,
            bytes: e.bytes,
          },
        });
        if (e.status === 'denied')
          await this.audit.record(tx, ctx, {
            action: 'ai.tool_denied',
            targetType: 'ai_run',
            targetId: setup.runId,
            metadata: { tool: e.tool, input: e.input as Prisma.InputJsonValue },
          });
      }
      await tx.aiMessage.create({
        data: {
          organizationId: ctx.organizationId,
          conversationId,
          role: 'assistant',
          content: result.text,
          evidence: evidence as Prisma.InputJsonValue,
          missing: result.missing,
          confidence: result.confidence,
          validation: result.validation,
          runId: setup.runId,
        },
      });
      await tx.aiRun.update({
        where: { id: setup.runId },
        data: {
          status: result.validation === 'partial' ? 'partial' : 'completed',
          provider: result.provider ?? provider.id,
          toolCalls: result.toolCalls,
          finishedAt: this.now(),
        },
      });
      await tx.aiConversation.update({ where: { id: conversationId }, data: { updatedAt: this.now() } });
    });

    out.event('answer', {
      text: result.text,
      evidence,
      missing: result.missing,
      confidence: result.confidence,
      validation: result.validation,
      problems: result.problems,
    });
    out.close({ event: 'done', data: { runId: setup.runId } });
  }

  private userId(ctx: TenantContext): string | null {
    return ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  }
}
