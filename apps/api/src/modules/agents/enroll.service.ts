import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { validateMessage } from '@pcp/agent-protocol';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException } from '../../common/errors.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import { InvalidCsrError, parseCsr } from './ca/csr.js';
import { AGENT_SETTINGS, requireSettings, type AgentSettings } from './settings.provider.js';
import { EnrollmentTokens } from './tokens.js';

const PROTOCOL_VERSION = '1.0';

interface EnrollRequest {
  protocolVersion: string;
  enrollmentToken: string;
  agentVersion: string;
  agentType: 'host' | 'private_worker';
  csrPem: string;
  x25519PublicKey: string;
  host: { hostname: string; machineId: string; os: string; arch: string };
}

interface ConsumedEnrollment {
  id: string;
  organization_id: string;
  product_id: string;
  environment_id: string;
  agent_type: 'host' | 'private_worker';
}

/** One message for every token failure, so callers cannot tell unknown from used or expired (TC-03-02). */
const invalidToken = () =>
  new ApiException(401, 'invalid_enrollment_token', 'The enrollment token is invalid, used, or expired');

/** Agent side of enrollment (UC-03-02): exchange a one-time token for an identity and certificate. */
@Injectable()
export class EnrollService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AGENT_SETTINGS) private readonly settings: AgentSettings | null,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly tokens: EnrollmentTokens,
    private readonly audit: AuditService,
  ) {}

  async enroll(body: unknown, requestId: string) {
    const settings = requireSettings(this.settings);
    const version = (body as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (typeof version === 'string' && version !== PROTOCOL_VERSION)
      throw new ApiException(
        426,
        'upgrade_required',
        `Protocol ${version} is not supported; upgrade the agent`,
      );
    const check = validateMessage('enroll-request', body);
    if (!check.ok)
      throw new ApiException(400, 'invalid_request', `Invalid enroll request: ${check.errors.join('; ')}`);
    const req = body as EnrollRequest;
    try {
      await parseCsr(req.csrPem);
    } catch (err) {
      if (err instanceof InvalidCsrError) throw new ApiException(400, 'invalid_csr', err.message);
      throw err;
    }

    const [enrollment] = await this.prisma.$queryRaw<ConsumedEnrollment[]>`
      SELECT id, organization_id, product_id, environment_id, agent_type
      FROM pcp_consume_enrollment(${this.tokens.hash(req.enrollmentToken)})`;
    if (!enrollment) throw invalidToken();

    const agentId = randomUUID();
    const issued = await settings.ca.issue(req.csrPem, agentId, this.now());
    const ctx: TenantContext = {
      organizationId: enrollment.organization_id,
      actor: { kind: 'system', jobId: `agent-enroll:${enrollment.id}` },
      roles: [],
      productIds: [enrollment.product_id],
      environmentIds: [enrollment.environment_id],
      requestId,
    };
    await withTenant(this.prisma, ctx, async (tx) => {
      await tx.agent.create({
        data: {
          id: agentId,
          organizationId: enrollment.organization_id,
          productId: enrollment.product_id,
          environmentId: enrollment.environment_id,
          enrollmentId: enrollment.id,
          agentType: enrollment.agent_type,
          hostname: req.host.hostname,
          machineId: req.host.machineId,
          os: req.host.os,
          arch: req.host.arch,
          agentVersion: req.agentVersion,
        },
      });
      await tx.agentCredential.create({
        data: {
          organizationId: enrollment.organization_id,
          agentId,
          fingerprintSha256: issued.fingerprintSha256,
          serial: issued.serial,
          notAfter: new Date(issued.notAfter),
        },
      });
      await tx.agentPublicKey.create({
        data: {
          organizationId: enrollment.organization_id,
          agentId,
          kind: 'x25519',
          publicKey: req.x25519PublicKey,
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'agent.enrolled',
        targetType: 'agent',
        targetId: agentId,
        metadata: { enrollmentId: enrollment.id, hostname: req.host.hostname },
      });
    });

    return {
      agentId,
      certificatePem: issued.certificatePem,
      chainPem: issued.chainPem,
      notAfter: issued.notAfter,
      controlUrl: settings.config.controlUrl,
      ingestUrl: settings.config.ingestUrl,
      opampUrl: settings.config.opampUrl,
      taskSigningPublicKey: settings.signer.publicKeyBase64(),
    };
  }
}
