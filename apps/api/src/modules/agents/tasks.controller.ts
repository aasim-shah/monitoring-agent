import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { RequirePermission, TenantScope } from '../../common/decorators.js';
import type { ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { AGENT } from './agents.controller.js';
import { TasksService } from './tasks.service.js';

@Controller('api/v1')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /** Asks the agent to report its own facts; proves the task path end to end. */
  @RequirePermission('agent.enroll')
  @TenantScope(AGENT)
  @Post('agents/:id/diagnostics')
  @HttpCode(202)
  async diagnostics(@Req() req: ApiRequest, @Param('id') id: string) {
    const task = await this.tasks.create(requireTenant(req), id, {
      type: 'inspect',
      payload: { target: 'agent_info' },
    });
    return { taskId: task.id };
  }

  @RequirePermission('agent.view')
  @TenantScope(AGENT)
  @Get('agents/:id/tasks')
  async list(@Req() req: ApiRequest, @Param('id') id: string) {
    return { tasks: await this.tasks.list(requireTenant(req), id) };
  }
}
