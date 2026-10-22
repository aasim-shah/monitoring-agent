import { Body, Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { RequirePermission, SessionOnly, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import { requireAuth, type ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { OrganizationsService } from './organizations.service.js';
import { createOrganizationBody, updateSettingsBody } from './schemas.js';

const view = (org: { id: string; name: string; timezone: string; settings: unknown; createdAt: Date }) => ({
  id: org.id,
  name: org.name,
  timezone: org.timezone,
  settings: org.settings,
  createdAt: org.createdAt,
});

@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

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
}
