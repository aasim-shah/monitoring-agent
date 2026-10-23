import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { ActionsService } from './actions.service.js';

const REQUEST = { param: 'id', resource: 'action_request' } as const;
const ROLES = z.enum(['owner', 'admin', 'operator']);

const policyBody = z
  .object({
    environmentId: z.string().uuid(),
    enabled: z.boolean(),
    approverRoles: z.array(ROLES).max(3).default([]),
    requireApproval: z.boolean().default(true),
    settings: z
      .object({
        units: z.array(z.string().max(128)).max(50).optional(),
        zones: z.array(z.string().max(64)).max(20).optional(),
        workflows: z
          .array(z.object({ workflow: z.string().max(128), ref: z.string().max(100) }).strict())
          .max(20)
          .optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

const proposalBody = z
  .object({
    productId: z.string().uuid(),
    environmentId: z.string().uuid(),
    capability: z.string().max(64),
    target: z.record(z.string(), z.unknown()),
    params: z.record(z.string(), z.unknown()).default({}),
    idempotencyKey: z.string().min(8).max(128),
    reason: z.string().trim().max(500).optional(),
    incidentId: z.string().uuid().optional(),
  })
  .strict();

const noteBody = z.object({ note: z.string().trim().max(500).optional() }).strict();
const rejectBody = z.object({ note: z.string().trim().min(1, 'Say why').max(500) }).strict();

@Controller('api/v1')
export class ActionsController {
  constructor(private readonly actions: ActionsService) {}

  @RequirePermission('incident.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/action-policies')
  policies(@Req() req: ApiRequest, @Param('productId') productId: string) {
    return this.actions.policies(requireTenant(req), productId);
  }

  @RequirePermission('org.settings.manage')
  @TenantScope({ param: 'productId' })
  @Put('products/:productId/action-policies/:type')
  putPolicy(
    @Req() req: ApiRequest,
    @Param('productId') productId: string,
    @Param('type') type: string,
    @Body() body: unknown,
  ) {
    return this.actions.putPolicy(requireTenant(req), productId, type, parseBody(policyBody, body));
  }

  /** UC-16-02: users propose; the AI proposes through its own tool, never through this route. */
  @RequirePermission('action.propose')
  @TenantScope({ body: 'productId' })
  @Post('actions/proposals')
  @HttpCode(201)
  propose(@Req() req: ApiRequest, @Body() body: unknown) {
    return this.actions.propose(requireTenant(req), parseBody(proposalBody, body), { proposedByAi: false });
  }

  @RequirePermission('incident.view')
  @TenantScope({ param: 'productId' })
  @Get('products/:productId/actions')
  list(@Req() req: ApiRequest, @Param('productId') productId: string, @Query('status') status?: string) {
    return this.actions.list(requireTenant(req), productId, status);
  }

  @RequirePermission('incident.view')
  @TenantScope(REQUEST)
  @Get('actions/:id')
  get(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.actions.get(requireTenant(req), id);
  }

  @RequirePermission('incident.view')
  @TenantScope(REQUEST)
  @Get('actions/:id/executions')
  executions(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.actions.executions(requireTenant(req), id);
  }

  /** Approver roles come from the action policy (spec §2.1: policy-dependent approval). */
  @RequirePermission('action.propose')
  @TenantScope(REQUEST)
  @Post('actions/:id/approve')
  @HttpCode(200)
  approve(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.actions.approve(requireTenant(req), id, parseBody(noteBody, body ?? {}).note);
  }

  @RequirePermission('action.propose')
  @TenantScope(REQUEST)
  @Post('actions/:id/reject')
  @HttpCode(200)
  reject(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.actions.reject(requireTenant(req), id, parseBody(rejectBody, body ?? {}).note);
  }
}
