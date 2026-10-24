import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AgentRoute } from '../../common/decorators.js';
import { notFound, parseBody } from '../../common/errors.js';
import { requireAgent, type ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { TasksService } from './tasks.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resultBody = z.object({
  status: z.enum(['succeeded', 'failed']),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(4096).optional(),
});

@Controller('agent/v1')
export class AgentTasksController {
  constructor(private readonly tasks: TasksService) {}

  @AgentRoute()
  @Get('tasks')
  async poll(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('wait') wait?: string,
  ) {
    const seconds = Math.max(0, Math.min(25, Number.parseInt(wait ?? '0', 10) || 0));
    // An agent that restarts abandons its long-poll; stop waiting so the poll cannot claim a task
    // and answer a closed connection (the task would be lost as "delivered").
    const gone = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    return { tasks: await this.tasks.poll(requireTenant(req), requireAgent(req), seconds, gone.signal) };
  }

  @AgentRoute()
  @Post('tasks/:id/result')
  @HttpCode(204)
  async result(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    if (!UUID.test(id)) throw notFound();
    await this.tasks.result(requireTenant(req), requireAgent(req), id, parseBody(resultBody, body));
  }

  @AgentRoute()
  @Post('streams/:sessionId/chunks')
  @HttpCode(202)
  async chunk(@Req() req: ApiRequest, @Param('sessionId') sessionId: string, @Body() body: unknown) {
    if (!UUID.test(sessionId)) throw notFound();
    await this.tasks.chunk(requireTenant(req), requireAgent(req), sessionId, body);
    return { accepted: true };
  }
}
