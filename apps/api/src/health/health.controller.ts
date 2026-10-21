import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { runChecks, type ReadinessCheck } from '@pcp/health';
import { Public } from '../common/decorators.js';
import type { AppConfig } from '../config.js';
import { APP_CONFIG, READINESS_CHECKS } from '../tokens.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'deploymentMode'>,
  ) {}

  @Public()
  @Get('healthz')
  healthz() {
    return { status: 'ok', service: 'api', deploymentMode: this.config.deploymentMode };
  }

  @Public()
  @Get('readyz')
  async readyz(@Res({ passthrough: true }) reply: FastifyReply) {
    const report = await runChecks(this.checks);
    reply.status(report.ok ? 200 : 503);
    return { status: report.ok ? 'ready' : 'not_ready', checks: report.results };
  }
}
