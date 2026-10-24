import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequirePermission, SessionOnly, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import { requireAuth, type ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { LifecycleService } from './lifecycle.service.js';
import { OrganizationsService } from './organizations.service.js';
import { createOrganizationBody, updateSettingsBody } from './schemas.js';

const view = (org: {
  id: string;
  name: string;
  timezone: string;
  settings: unknown;
  createdAt: Date;
  deletionScheduledFor?: Date | null;
}) => ({
  id: org.id,
  name: org.name,
  timezone: org.timezone,
  settings: org.settings,
  createdAt: org.createdAt,
  /** Set while a deletion is pending: the purge time (WB-17 UC-17-09). */
  deletionScheduledFor: org.deletionScheduledFor ?? null,
});

const deletionBody = z.object({ confirmName: z.string().min(1).max(200) }).strict();

@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly lifecycle: LifecycleService,
  ) {}

  @SessionOnly()
  @Post()
  @HttpCode(201)
  async create(@Req() req: ApiRequest, @Body() body: unknown) {
    const { user } = requireAuth(req);
    return view(
      await this.organizations.create(user.id, String(req.id), parseBody(createOrganizationBody, body)),
    );
  }

  @RequirePermission('org.view')
  @TenantScope({ param: 'orgId' })
  @Get(':orgId')
  async get(@Req() req: ApiRequest) {
    const ctx = requireTenant(req);
    return { ...view(await this.organizations.get(ctx)), role: ctx.roles[0] };
  }

  @RequirePermission('org.settings.manage')
  @TenantScope({ param: 'orgId' })
  @Patch(':orgId/settings')
  async updateSettings(@Req() req: ApiRequest, @Body() body: unknown) {
    return view(
      await this.organizations.updateSettings(requireTenant(req), parseBody(updateSettingsBody, body)),
    );
  }

  /** Owner only, with the organization name typed back; recoverable for 30 days. */
  @RequirePermission('org.delete')
  @TenantScope({ param: 'orgId' })
  @Delete(':orgId')
  @HttpCode(202)
  async requestDeletion(@Req() req: ApiRequest, @Body() body: unknown) {
    const { confirmName } = parseBody(deletionBody, body);
    return view(await this.lifecycle.requestDeletion(requireTenant(req), confirmName));
  }

  @RequirePermission('org.delete')
  @TenantScope({ param: 'orgId' })
  @Post(':orgId/deletion/cancel')
  @HttpCode(204)
  async cancelDeletion(@Req() req: ApiRequest) {
    await this.lifecycle.cancelDeletion(requireTenant(req));
  }

  @RequirePermission('org.export')
  @TenantScope({ param: 'orgId' })
  @Post(':orgId/export')
  @HttpCode(202)
  async requestExport(@Req() req: ApiRequest) {
    const e = await this.lifecycle.requestExport(requireTenant(req));
    return { id: e.id, status: e.status, createdAt: e.createdAt };
  }

  @RequirePermission('org.export')
  @TenantScope({ param: 'orgId' })
  @Get(':orgId/export')
  async listExports(@Req() req: ApiRequest) {
    return { exports: await this.lifecycle.listExports(requireTenant(req)) };
  }

  @RequirePermission('org.export')
  @TenantScope({ param: 'orgId' })
  @Get(':orgId/export/:exportId/download')
  async download(@Req() req: ApiRequest, @Param('exportId') exportId: string, @Res() reply: FastifyReply) {
    const { archive, createdAt } = await this.lifecycle.exportArchive(requireTenant(req), exportId);
    const day = createdAt.toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="pcp-export-${day}.json.gz"`)
      .header('cache-control', 'no-store')
      .send(archive);
  }
}
