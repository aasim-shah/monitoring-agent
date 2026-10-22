import { Controller, Get, Req } from '@nestjs/common';
import { AgentRoute } from '../../common/decorators.js';
import { requireAgent, type ApiRequest } from '../../common/request.js';

@Controller('agent/v1')
export class WhoamiController {
  /** Lets `pcp-agentctl status` confirm the certificate is accepted. */
  @AgentRoute()
  @Get('whoami')
  whoami(@Req() req: ApiRequest) {
    return { agentId: requireAgent(req).id };
  }
}
