import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { RequirePermission, SessionOnly, TenantScope } from '../../common/decorators.js';
import { notFound, parseBody } from '../../common/errors.js';
import { requireAuth, type ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { MembersService } from './members.service.js';
import { acceptInvitationBody, createInvitationBody, updateMemberBody } from './schemas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const memberIdOrNotFound = (id: string) => {
  if (!UUID.test(id)) throw notFound();
  return id;
};

@Controller('api/v1')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @RequirePermission('org.members.manage')
  @TenantScope({ param: 'orgId' })
  @Post('organizations/:orgId/invitations')
  @HttpCode(201)
  invite(@Req() req: ApiRequest, @Body() body: unknown) {
    return this.members.invite(requireTenant(req), parseBody(createInvitationBody, body));
  }

  @SessionOnly()
  @Post('invitations/accept')
  @HttpCode(200)
  accept(@Req() req: ApiRequest, @Body() body: unknown) {
    const { user } = requireAuth(req);
    return this.members.accept(user, String(req.id), parseBody(acceptInvitationBody, body).token);
  }

  @RequirePermission('org.view')
  @TenantScope({ param: 'orgId' })
  @Get('organizations/:orgId/members')
  async list(@Req() req: ApiRequest) {
    return { members: await this.members.list(requireTenant(req)) };
  }

  @RequirePermission('org.members.manage')
  @TenantScope({ param: 'orgId' })
  @Patch('organizations/:orgId/members/:memberId')
  update(@Req() req: ApiRequest, @Param('memberId') memberId: string, @Body() body: unknown) {
    return this.members.update(
      requireTenant(req),
      memberIdOrNotFound(memberId),
      parseBody(updateMemberBody, body),
    );
  }

  @RequirePermission('org.members.manage')
  @TenantScope({ param: 'orgId' })
  @Delete('organizations/:orgId/members/:memberId')
  @HttpCode(204)
  async remove(@Req() req: ApiRequest, @Param('memberId') memberId: string) {
    await this.members.remove(requireTenant(req), memberIdOrNotFound(memberId));
  }
}
