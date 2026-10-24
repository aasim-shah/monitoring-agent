import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Internal, RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { InstallSessionsService } from './install-sessions.service.js';

const SESSION = { param: 'id', resource: 'install_session' } as const;

/** A hostname or an IP address: no spaces, quotes, or shell characters (Review Focus #3). */
const host = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^[0-9a-fA-F:.]+$/,
  );
const createBody = z
  .object({
    mode: z.enum(['key', 'password']),
    hosts: z
      .array(
        z
          .object({
            host,
            port: z.number().int().min(1).max(65535).default(22),
            username: z
              .string()
              .regex(/^[a-z_][a-z0-9_-]{0,31}$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .refine(
        (hs) => new Set(hs.map((h) => `${h.host}:${h.port}`)).size === hs.length,
        'hosts must be unique',
      ),
  })
  .strict();
const connectBody = z.object({ password: z.string().min(1).max(1024).optional() }).strict();
const confirmBody = z.object({ fingerprint: z.string().min(1).max(200) }).strict();
const reportBody = z
  .object({
    organizationId: z.string().uuid(),
    status: z.enum(['connecting', 'awaiting_confirmation', 'installing', 'installed', 'failed']),
    fingerprint: z.string().max(200).optional(),
    output: z.string().max(70_000).optional(),
    scriptVersion: z.string().max(128).optional(),
    cleanup: z.enum(['done', 'failed', 'not_needed']).optional(),
    error: z.string().max(2000).optional(),
  })
  .strict();

/** Assisted SSH install (WB-05 UC-05-05/06). Starting one needs `agent.enroll`. */
@Controller('api/v1')
export class InstallSessionsController {
  constructor(private readonly sessions: InstallSessionsService) {}

  @RequirePermission('agent.enroll')
  @TenantScope({ param: 'environmentId' })
  @Post('environments/:environmentId/install-sessions')
  create(@Req() req: ApiRequest, @Param('environmentId') environmentId: string, @Body() body: unknown) {
    return this.sessions.create(requireTenant(req), environmentId, parseBody(createBody, body));
  }

  @RequirePermission('agent.enroll')
  @TenantScope(SESSION)
  @Get('install-sessions/:id')
  get(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.sessions.get(requireTenant(req), id);
  }

  @RequirePermission('agent.enroll')
  @TenantScope(SESSION)
  @Post('install-sessions/:id/connect')
  @HttpCode(202)
  async connect(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    await this.sessions.connect(requireTenant(req), id, parseBody(connectBody, body ?? {}).password);
    return { status: 'connecting' };
  }

  @RequirePermission('agent.enroll')
  @TenantScope(SESSION)
  @Post('install-sessions/:id/hosts/:hostId/confirm-fingerprint')
  @HttpCode(202)
  async confirm(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Param('hostId') hostId: string,
    @Body() body: unknown,
  ) {
    await this.sessions.confirm(requireTenant(req), id, hostId, parseBody(confirmBody, body).fingerprint);
    return { status: 'installing' };
  }

  @RequirePermission('agent.enroll')
  @TenantScope(SESSION)
  @Delete('install-sessions/:id')
  @HttpCode(204)
  async abort(@Req() req: ApiRequest, @Param('id') id: string) {
    await this.sessions.abort(requireTenant(req), id);
  }
}

/** The installer runner's per-host progress (X-Internal-Token; Caddy never routes /internal). */
@Controller('internal/v1')
export class InternalInstallSessionsController {
  constructor(private readonly sessions: InstallSessionsService) {}

  @Internal()
  @Post('install-sessions/:id/hosts/:hostId')
  @HttpCode(204)
  async report(@Param('id') id: string, @Param('hostId') hostId: string, @Body() body: unknown) {
    await this.sessions.report(id, hostId, parseBody(reportBody, body));
  }
}
