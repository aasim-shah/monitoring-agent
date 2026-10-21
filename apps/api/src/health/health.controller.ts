import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { runChecks, type ReadinessCheck } from '@pcp/health';
import type { AppConfig } from '../config.js';
import { APP_CONFIG, READINESS_CHECKS } from '../tokens.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'deploymentMode'>,
  ) {}

  @Get('healthz')
  healthz() {
    return { status: 'ok', service: 'api', deploymentMode: this.config.deploymentMode };
  }

  @Get('readyz')
  async readyz() {
    const report = await runChecks(this.checks);
    const body = { status: report.ok ? 'ready' : 'not_ready', checks: report.results };
    if (!report.ok) throw new ServiceUnavailableException(body);
    return body;
  }
}
