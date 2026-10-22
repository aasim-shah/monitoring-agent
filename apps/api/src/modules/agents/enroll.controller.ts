import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { AgentEnroll } from '../../common/decorators.js';
import { ApiException } from '../../common/errors.js';
import type { ApiRequest } from '../../common/request.js';
import { RateLimiter } from '../identity/rate-limiter.js';
import { EnrollService } from './enroll.service.js';

@Controller('agent/v1')
export class EnrollController {
  constructor(
    private readonly enrollService: EnrollService,
    private readonly limiter: RateLimiter,
  ) {}

  /** 10 attempts/min/IP, like the auth endpoints (§3). */
  @AgentEnroll()
  @Post('enroll')
  @HttpCode(201)
  async enroll(@Req() req: ApiRequest, @Body() body: unknown) {
    const { allowed, retryAfterSeconds } = await this.limiter.hit(`agent-enroll:${req.ip}`);
    if (!allowed)
      throw new ApiException(429, 'rate_limited', 'Too many enrollment attempts; try again later', {
        'retry-after': String(retryAfterSeconds),
      });
    return this.enrollService.enroll(body, String(req.id));
  }
}
