import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { AuditService } from './audit.service.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().max(500).optional(),
});

@Controller('api/v1/organizations')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermission('audit.view')
  @TenantScope({ param: 'orgId' })
  @Get(':orgId/audit-logs')
  list(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.audit.list(requireTenant(req), parseBody(listQuery, query));
  }
}
