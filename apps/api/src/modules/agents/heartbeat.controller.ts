import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { validateMessage } from '@pcp/agent-protocol';
import type { PrismaClient } from '@pcp/database';
import { withTenant } from '@pcp/tenant-security';
import { AgentRoute } from '../../common/decorators.js';
import { ApiException } from '../../common/errors.js';
import { requireAgent, type ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { CLOCK, PRISMA } from '../../tokens.js';

const SKEW_TOLERANCE_MS = 300_000;

interface Heartbeat {
  sequence: number;
  agentVersion: string;
  policyVersion: number;
  capabilities: string[];
  health: string;
  queueDepth: number;
  sentAt: string;
}

@Controller('agent/v1')
export class HeartbeatController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  /**
   * Every 30 s (§3). A sequence not above the last one seen is a replay or reordering:
   * acknowledged as `accepted: false` and not stored. Clock skew over 5 min is recorded.
   */
  @AgentRoute()
  @Post('heartbeat')
  @HttpCode(202)
  async heartbeat(@Req() req: ApiRequest, @Body() body: unknown) {
    const check = validateMessage('heartbeat', body);
    if (!check.ok)
      throw new ApiException(400, 'invalid_request', `Invalid heartbeat: ${check.errors.join('; ')}`);
    const hb = body as Heartbeat;
    const agent = requireAgent(req);
    const now = this.now();
    const skewMs = new Date(hb.sentAt).getTime() - now.getTime();
    const clockSkewSeconds = Math.abs(skewMs) > SKEW_TOLERANCE_MS ? Math.round(skewMs / 1000) : null;
    return withTenant(this.prisma, requireTenant(req), async (tx) => {
      const { count } = await tx.agent.updateMany({
        where: {
          id: agent.id,
          OR: [{ lastSequence: null }, { lastSequence: { lt: BigInt(hb.sequence) } }],
        },
        data: {
          lastHeartbeatAt: now,
          lastSequence: BigInt(hb.sequence),
          agentVersion: hb.agentVersion,
          capabilities: hb.capabilities,
          clockSkewSeconds,
        },
      });
      const { policyVersion } = await tx.agent.findUniqueOrThrow({
        where: { id: agent.id },
        select: { policyVersion: true },
      });
      if (count === 0) return { accepted: false, policyVersion };
      await tx.agentHeartbeat.create({
        data: {
          organizationId: agent.organizationId,
          agentId: agent.id,
          receivedAt: now,
          sentAt: new Date(hb.sentAt),
          sequence: BigInt(hb.sequence),
          health: hb.health,
          queueDepth: hb.queueDepth,
          agentVersion: hb.agentVersion,
          policyVersion: hb.policyVersion,
        },
      });
      return { accepted: true, policyVersion };
    });
  }
}
