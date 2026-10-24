import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { ConnectionsService } from './connections.service.js';
import { authorizeBody, createConnectionBody, resourceScopesBody, templateRunBody } from './schemas.js';

interface ConnectionRow {
  id: string;
  provider: string;
  displayName: string;
  executionLocation: string;
  status: string;
  statusReason: string | null;
  config: unknown;
  lastValidatedAt: Date | null;
  createdAt: Date;
  scopes: ScopeRow[];
  grantedScopes: string[];
  accountEmail: string | null;
}

interface ScopeRow {
  externalId: string;
  resourceType: string;
  name: string;
  productId: string;
  environmentId: string | null;
}

const scopeView = (s: ScopeRow) => ({
  externalId: s.externalId,
  resourceType: s.resourceType,
  name: s.name,
  productId: s.productId,
  environmentId: s.environmentId,
});

/** Never includes credentials: only non-secret configuration and whether credentials are stored. */
const connectionView = (c: ConnectionRow) => ({
  id: c.id,
  provider: c.provider,
  displayName: c.displayName,
  executionLocation: c.executionLocation,
  status: c.status,
  statusReason: c.statusReason,
  config: c.config,
  lastValidatedAt: c.lastValidatedAt,
  createdAt: c.createdAt,
  scopes: c.scopes.map(scopeView),
  grantedScopes: c.grantedScopes,
  accountEmail: c.accountEmail,
});

const CONNECTION = { param: 'id', resource: 'connection' } as const;

@Controller('api/v1')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @RequirePermission('connection.configure')
  @TenantScope({ param: 'orgId' })
  @Post('organizations/:orgId/connections')
  @HttpCode(201)
  async create(@Req() req: ApiRequest, @Body() body: unknown) {
    return connectionView(
      await this.connections.create(requireTenant(req), parseBody(createConnectionBody, body)),
    );
  }

  @RequirePermission('connection.view')
  @TenantScope({ param: 'orgId' })
  @Get('organizations/:orgId/connections')
  async list(@Req() req: ApiRequest) {
    const ctx = requireTenant(req);
    const rows = await this.connections.list(ctx);
    return {
      connections: await Promise.all(
        rows.map(async (c) => ({
          ...connectionView(c),
          ...(await this.connections.effectiveStatus(ctx, c)),
        })),
      ),
    };
  }

  @RequirePermission('connection.view')
  @TenantScope(CONNECTION)
  @Get('connections/:id')
  async get(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = requireTenant(req);
    const [c, hasCredentials] = await Promise.all([
      this.connections.get(ctx, id),
      this.connections.hasCredentials(ctx, id),
    ]);
    return { ...connectionView(c), ...(await this.connections.effectiveStatus(ctx, c)), hasCredentials };
  }

  /** Latest health checks and the last template result (private connections, WB-07). */
  @RequirePermission('connection.view')
  @TenantScope(CONNECTION)
  @Get('connections/:id/health')
  health(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.connections.health(requireTenant(req), id);
  }

  @RequirePermission('connection.configure')
  @TenantScope(CONNECTION)
  @Post('connections/:id/write-override')
  @HttpCode(202)
  async writeOverride(@Req() req: ApiRequest, @Param('id') id: string) {
    return { taskId: await this.connections.acknowledgeWriteOverride(requireTenant(req), id) };
  }

  @RequirePermission('connection.configure')
  @TenantScope(CONNECTION)
  @Post('connections/:id/templates/:name/run')
  @HttpCode(202)
  async runTemplate(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    const params = parseBody(templateRunBody, body);
    return { taskId: await this.connections.runTemplate(requireTenant(req), id, name, params) };
  }

  @RequirePermission('connection.configure')
  @TenantScope(CONNECTION)
  @Post('connections/:id/authorize')
  @HttpCode(200)
  async authorize(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const { credentials } = parseBody(authorizeBody, body);
    return connectionView(await this.connections.authorize(requireTenant(req), id, credentials));
  }

  @RequirePermission('connection.configure')
  @TenantScope(CONNECTION)
  @Post('connections/:id/validate')
  @HttpCode(202)
  async validate(@Req() req: ApiRequest, @Param('id') id: string) {
    return { jobId: await this.connections.request(requireTenant(req), id, 'connection-validate') };
  }

  @RequirePermission('connection.configure')
  @TenantScope(CONNECTION)
  @Post('connections/:id/discover')
  @HttpCode(202)
  async discover(@Req() req: ApiRequest, @Param('id') id: string) {
    return { jobId: await this.connections.request(requireTenant(req), id, 'connection-discover') };
  }

  @RequirePermission('connection.configure')
  @TenantScope(CONNECTION)
  @Get('connections/:id/resources')
  async resources(@Req() req: ApiRequest, @Param('id') id: string) {
    return { resources: await this.connections.resources(requireTenant(req), id) };
  }

  @RequirePermission('connection.configure')
  @TenantScope(CONNECTION)
  @Post('connections/:id/resource-scopes')
  @HttpCode(200)
  async setScopes(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const { scopes } = parseBody(resourceScopesBody, body);
    return { scopes: (await this.connections.setScopes(requireTenant(req), id, scopes)).map(scopeView) };
  }

  @RequirePermission('connection.view')
  @TenantScope(CONNECTION)
  @Get('connections/:id/sync-runs')
  async syncRuns(@Req() req: ApiRequest, @Param('id') id: string) {
    const runs = await this.connections.syncRuns(requireTenant(req), id);
    return {
      runs: runs.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        items: r.items,
        createdAt: r.createdAt,
      })),
    };
  }

  @RequirePermission('connection.view')
  @TenantScope(CONNECTION)
  @Get('connections/:id/webhook-deliveries')
  async webhookDeliveries(@Req() req: ApiRequest, @Param('id') id: string) {
    const rows = await this.connections.webhookDeliveries(requireTenant(req), id);
    return {
      deliveries: rows.map((d) => ({
        id: d.id,
        deliveryId: d.deliveryId,
        eventType: d.eventType,
        result: d.result,
        detail: d.detail,
        receivedAt: d.receivedAt,
      })),
    };
  }

  @RequirePermission('connection.view')
  @TenantScope(CONNECTION)
  @Get('connections/:id/change-events')
  async changeEvents(@Req() req: ApiRequest, @Param('id') id: string) {
    const rows = await this.connections.changeEvents(requireTenant(req), id);
    return {
      events: rows.map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
        url: e.url,
        actor: e.actor,
        externalId: e.externalId,
        occurredAt: e.occurredAt,
      })),
    };
  }

  @RequirePermission('connection.view')
  @TenantScope(CONNECTION)
  @Get('connections/:id/inventory')
  async inventory(@Req() req: ApiRequest, @Param('id') id: string) {
    const rows = await this.connections.inventory(requireTenant(req), id);
    return {
      items: rows.map((i) => ({
        externalId: i.externalId,
        resourceType: i.resourceType,
        name: i.name,
        attributes: i.attributes,
      })),
    };
  }

  @RequirePermission('connection.configure')
  @TenantScope(CONNECTION)
  @Delete('connections/:id')
  @HttpCode(202)
  async remove(@Req() req: ApiRequest, @Param('id') id: string) {
    return { status: await this.connections.remove(requireTenant(req), id) };
  }
}
