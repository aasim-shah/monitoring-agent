import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Internal, RequirePermission, TenantScope } from '../../common/decorators.js';
import { ApiException, parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { ChannelsService } from './channels.service.js';
import { IncidentsService, type AlertmanagerAlert } from './incidents.service.js';
import { RulesService } from './rules.service.js';
import {
  createChannelBody,
  createRuleBody,
  incidentListQuery,
  postmortemBody,
  resolveBody,
  updateChannelBody,
  updateRuleBody,
} from './schemas.js';

const RULE = { param: 'id', resource: 'alert_rule' } as const;
const INCIDENT = { param: 'id', resource: 'incident' } as const;
const CHANNEL = { param: 'id', resource: 'notification_channel' } as const;

@Controller()
export class AlertingController {
  constructor(
    private readonly rules: RulesService,
    private readonly incidents: IncidentsService,
    private readonly channels: ChannelsService,
  ) {}

  // ----- alert rules (UC-13-01) -----

  @RequirePermission('incident.view')
  @TenantScope({ param: 'productId' })
  @Get('api/v1/products/:productId/alert-rules')
  listRules(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.rules.list(requireTenant(req), productId);
  }

  @RequirePermission('incident.manage')
  @TenantScope({ param: 'productId' })
  @Post('api/v1/products/:productId/alert-rules')
  createRule(@Req() req: ApiRequest, @Param('productId') productId: string, @Body() body: unknown) {
    return this.rules.create(requireTenant(req), productId, parseBody(createRuleBody, body));
  }

  @RequirePermission('incident.manage')
  @TenantScope({ param: 'productId' })
  @Post('api/v1/products/:productId/alert-rules/recommended')
  recommended(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.rules.recommended(requireTenant(req), productId);
  }

  @RequirePermission('incident.manage')
  @TenantScope(RULE)
  @Patch('api/v1/alert-rules/:id')
  updateRule(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rules.update(requireTenant(req), id, parseBody(updateRuleBody, body));
  }

  @RequirePermission('incident.manage')
  @TenantScope(RULE)
  @Delete('api/v1/alert-rules/:id')
  @HttpCode(204)
  async deleteRule(@Req() req: ApiRequest, @Param('id') id: string) {
    await this.rules.remove(requireTenant(req), id);
  }

  // ----- incidents (UC-13-04..11) -----

  @RequirePermission('incident.view')
  @TenantScope({ param: 'productId' })
  @Get('api/v1/products/:productId/incidents')
  listIncidents(
    @Req() req: ApiRequest,
    @Param('productId') productId: string,
    @Query('status') status?: string,
  ) {
    const parsed = incidentListQuery.safeParse(status);
    if (!parsed.success) throw new ApiException(400, 'validation_failed', 'Invalid fields: status');
    return this.incidents.list(requireTenant(req), productId, parsed.data);
  }

  @RequirePermission('incident.view')
  @TenantScope(INCIDENT)
  @Get('api/v1/incidents/:id')
  incident(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.incidents.detail(requireTenant(req), id);
  }

  @RequirePermission('incident.manage')
  @TenantScope(INCIDENT)
  @Post('api/v1/incidents/:id/acknowledge')
  @HttpCode(200)
  acknowledgeIncident(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.incidents.acknowledge(requireTenant(req), id);
  }

  @RequirePermission('incident.manage')
  @TenantScope(INCIDENT)
  @Post('api/v1/incidents/:id/resolve')
  @HttpCode(200)
  resolveIncident(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.incidents.resolve(requireTenant(req), id, parseBody(resolveBody, body).note);
  }

  @RequirePermission('incident.manage')
  @TenantScope(INCIDENT)
  @Patch('api/v1/incidents/:id/postmortem')
  postmortem(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.incidents.postmortem(requireTenant(req), id, parseBody(postmortemBody, body));
  }

  // ----- notification channels (UC-13-09) -----

  @RequirePermission('org.view')
  @TenantScope({ param: 'orgId' })
  @Get('api/v1/organizations/:orgId/notification-channels')
  listChannels(@Req() req: ApiRequest) {
    return this.channels.list(requireTenant(req));
  }

  @RequirePermission('org.settings.manage')
  @TenantScope({ param: 'orgId' })
  @Post('api/v1/organizations/:orgId/notification-channels')
  createChannel(@Req() req: ApiRequest, @Body() body: unknown) {
    return this.channels.create(requireTenant(req), parseBody(createChannelBody, body));
  }

  @RequirePermission('org.settings.manage')
  @TenantScope(CHANNEL)
  @Patch('api/v1/notification-channels/:id')
  updateChannel(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.channels.update(requireTenant(req), id, parseBody(updateChannelBody, body));
  }

  @RequirePermission('org.settings.manage')
  @TenantScope(CHANNEL)
  @Delete('api/v1/notification-channels/:id')
  @HttpCode(204)
  async deleteChannel(@Req() req: ApiRequest, @Param('id') id: string) {
    await this.channels.remove(requireTenant(req), id);
  }

  @RequirePermission('org.settings.manage')
  @TenantScope(CHANNEL)
  @Post('api/v1/notification-channels/:id/test')
  @HttpCode(202)
  testChannel(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.channels.test(requireTenant(req), id);
  }

  // ----- vmalert notifier (UC-13-02, BR-13-08): internal network + X-Internal-Token only -----

  @Internal()
  @Post('internal/alertmanager/api/v2/alerts')
  @HttpCode(200)
  receive(@Body() body: unknown) {
    return this.incidents.receive(Array.isArray(body) ? (body as AlertmanagerAlert[]) : []);
  }
}
