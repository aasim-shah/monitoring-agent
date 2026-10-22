import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import { withTenant } from '@pcp/tenant-security';
import { z } from 'zod';
import { AgentRoute } from '../../common/decorators.js';
import { ApiException, parseBody } from '../../common/errors.js';
import { requireAgent, type ApiRequest } from '../../common/request.js';
import { requireTenant } from '../../common/tenant.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import { InvalidCsrError } from './ca/csr.js';
import { AGENT_SETTINGS, requireSettings, type AgentSettings } from './settings.provider.js';

const rotateBody = z.object({ csrPem: z.string().min(1).max(16_384) });

@Controller('agent/v1')
export class RotateController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AGENT_SETTINGS) private readonly settings: AgentSettings | null,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly audit: AuditService,
  ) {}

  /**
   * Certificate rotation (UC-03-04): the agent sends a CSR for a new host key. The calling
   * certificate is superseded and keeps working for 1 h so in-flight requests finish.
   */
  @AgentRoute()
  @Post('rotate')
  @HttpCode(201)
  async rotate(@Req() req: ApiRequest, @Body() body: unknown) {
    const { csrPem } = parseBody(rotateBody, body);
    const agent = requireAgent(req);
    const ctx = requireTenant(req);
    const now = this.now();
    let issued;
    try {
      issued = await requireSettings(this.settings).ca.issue(csrPem, agent.id, now);
    } catch (err) {
      if (err instanceof InvalidCsrError) throw new ApiException(400, 'invalid_csr', err.message);
      throw err;
    }
    await withTenant(this.prisma, ctx, async (tx) => {
      await tx.agentCredential.updateMany({
        where: { fingerprintSha256: agent.fingerprint, supersededAt: null },
        data: { supersededAt: now },
      });
      await tx.agentCredential.create({
        data: {
          organizationId: agent.organizationId,
          agentId: agent.id,
          fingerprintSha256: issued.fingerprintSha256,
          serial: issued.serial,
          notAfter: new Date(issued.notAfter),
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'agent.certificate_rotated',
        targetType: 'agent',
        targetId: agent.id,
        metadata: { serial: issued.serial, notAfter: issued.notAfter },
      });
    });
    return { certificatePem: issued.certificatePem, chainPem: issued.chainPem, notAfter: issued.notAfter };
  }
}
