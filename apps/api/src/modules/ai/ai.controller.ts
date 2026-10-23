import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { AiService } from './ai.service.js';

const CONVERSATION = { param: 'id', resource: 'ai_conversation' } as const;
const createBody = z.object({ title: z.string().trim().max(500).default('') }).strict();
const messageBody = z.object({ content: z.string().trim().min(1).max(4000) }).strict();
const settingsBody = z.object({ disabled: z.boolean() }).strict();

@Controller('api/v1')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @RequirePermission('ai.use')
  @TenantScope({ param: 'productId' })
  @Post('products/:productId/ai/conversations')
  @HttpCode(201)
  create(@Req() req: ApiRequest, @Param('productId') productId: string, @Body() body: unknown) {
    return this.ai.createConversation(requireTenant(req), productId, parseBody(createBody, body).title);
  }

  @RequirePermission('ai.use')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/ai/conversations')
  list(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.ai.listConversations(requireTenant(req), productId);
  }

  @RequirePermission('ai.use')
  @TenantScope(CONVERSATION)
  @Get('ai/conversations/:id')
  conversation(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.ai.conversation(requireTenant(req), id);
  }

  /** Server-sent events: `started`, `tool`, `answer`, `done` (WB-14 §7). */
  @RequirePermission('ai.use')
  @TenantScope(CONVERSATION)
  @Post('ai/conversations/:id/messages')
  async message(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ) {
    await this.ai.ask(requireTenant(req), id, parseBody(messageBody, body).content, reply);
  }

  @RequirePermission('org.view')
  @TenantScope({ param: 'orgId' })
  @Get('organizations/:orgId/settings/ai')
  settings(@Req() req: ApiRequest) {
    return this.ai.settings(requireTenant(req));
  }

  @RequirePermission('org.settings.manage')
  @TenantScope({ param: 'orgId' })
  @Patch('organizations/:orgId/settings/ai')
  update(@Req() req: ApiRequest, @Body() body: unknown) {
    return this.ai.updateSettings(requireTenant(req), parseBody(settingsBody, body).disabled);
  }
}
