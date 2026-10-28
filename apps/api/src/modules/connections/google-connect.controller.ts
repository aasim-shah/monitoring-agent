import { Body, Controller, Get, Param, Post, Query, Req, Res, HttpCode } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequirePermission, SessionOnly, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import { requireAuth, type ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { ConnectionsService } from './connections.service.js';
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
/** The key file's text as uploaded; the service parses and checks it. */
const serviceAccountBody = z
  .object({
    key: z
      .string()
      .min(2)
      .max(16 * 1024),
  })
  .strict();

@Controller('api/v1/connections')
export class GoogleConnectController {
  constructor(
    private readonly google: GoogleConnectService,
    private readonly connections: ConnectionsService,
  ) {}

  @RequirePermission('connection.configure')
  @TenantScope({ param: 'id', resource: 'connection' })
  @Post(':id/oauth/google/start')
  @HttpCode(200)
  start(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.google.start(requireTenant(req), id, parseBody(startBody, body));
  }

  /** Connects with an uploaded service account JSON key instead of Google sign-in. */
  @RequirePermission('connection.configure')
  @TenantScope({ param: 'id', resource: 'connection' })
  @Post(':id/google/service-account')
  @HttpCode(200)
  serviceAccount(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const { key } = parseBody(serviceAccountBody, body);
    return this.connections.setGoogleServiceAccount(requireTenant(req), id, key);
  }

  /** Re-checks what the stored service account can read, after the customer shared more. */
  @RequirePermission('connection.configure')
  @TenantScope({ param: 'id', resource: 'connection' })
  @Post(':id/google/service-account/check')
  @HttpCode(200)
  checkServiceAccount(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.connections.checkGoogleAccess(requireTenant(req), id);
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
