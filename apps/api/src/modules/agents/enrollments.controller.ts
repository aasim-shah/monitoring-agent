import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import { notFound, parseBody } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { EnrollmentsService } from './enrollments.service.js';
import { createEnrollmentBody } from './schemas.js';

@Controller('api/v1')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @RequirePermission('agent.enroll')
  @TenantScope({ param: 'environmentId' })
  @Post('environments/:environmentId/agent-enrollments')
  @HttpCode(201)
  create(@Req() req: ApiRequest, @Param('environmentId') environmentId: string, @Body() body: unknown) {
    return this.enrollments.create(requireTenant(req), environmentId, parseBody(createEnrollmentBody, body));
  }

  @RequirePermission('agent.view')
  @TenantScope({ param: 'environmentId' })
  @Get('environments/:environmentId/agent-enrollments')
  async list(@Req() req: ApiRequest, @Param('environmentId') environmentId: string) {
    return { enrollments: await this.enrollments.list(requireTenant(req), environmentId) };
  }

  @RequirePermission('agent.enroll')
  @TenantScope({ param: 'environmentId' })
  @Post('environments/:environmentId/agent-enrollments/:enrollmentId/revoke')
  @HttpCode(200)
  revoke(
    @Req() req: ApiRequest,
    @Param('environmentId') environmentId: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(enrollmentId)) throw notFound();
    return this.enrollments.revoke(requireTenant(req), environmentId, enrollmentId);
  }
}
