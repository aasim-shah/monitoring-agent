import { Body, Controller, Get, Param, Post, Query, Req, Res, HttpCode } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequirePermission, SessionOnly, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import { requireAuth, type ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { GoogleConnectService } from './google-connect.service.js';

const startBody = z
  .object({ productId: z.string().uuid(), missingOnly: z.boolean().default(false) })
  .strict();
const callbackQuery = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(2000).optional(),
  error: z.string().max(200).optional(),
  scope: z.string().optional(),
  authuser: z.string().optional(),
  prompt: z.string().optional(),
  hd: z.string().optional(),
  iss: z.string().optional(),
});

@Controller('api/v1/connections')
export class GoogleConnectController {
  constructor(private readonly google: GoogleConnectService) {}

  @RequirePermission('connection.configure')
  @TenantScope({ param: 'id', resource: 'connection' })
  @Post(':id/oauth/google/start')
  @HttpCode(200)
  start(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.google.start(requireTenant(req), id, parseBody(startBody, body));
  }

  /** Google redirects the browser here; the session cookie (SameSite=Lax) identifies the member. */
  @SessionOnly()
  @Get('oauth/google/callback')
  async callback(@Req() req: ApiRequest, @Query() query: unknown, @Res() reply: FastifyReply) {
    const { user } = requireAuth(req);
    const q = parseBody(callbackQuery, query);
    const to = await this.google.callback(user.id, String(req.id), q);
    return reply.redirect(to, 302);
  }
}
