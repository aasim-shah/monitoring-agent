import { Inject, Injectable } from '@nestjs/common';
import type { ConnectorRuntime } from '@pcp/connector-runtime';
import { bodyDigest } from '@pcp/connector-sdk';
import { Prisma, type PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException } from '../../common/errors.js';
import { PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import { CONNECTOR_RUNTIME } from '../connections/registry.provider.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every refusal looks the same: no hint whether the connection exists (BR-06-05). */
const refused = () => new ApiException(401, 'invalid_signature', 'Webhook signature is not valid');

const system = (organizationId: string, requestId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'webhook' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId,
});

/**
 * Provider webhooks (spec §7.7, WB-06 UC-06-10): verify with the connection's own secret,
 * deduplicate by delivery ID, normalize into change events. Payloads are never stored.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CONNECTOR_RUNTIME) private readonly runtime: ConnectorRuntime,
    private readonly audit: AuditService,
  ) {}

  async receive(input: {
    provider: string;
    connectionId: string;
    headers: Record<string, string>;
    rawBody: Buffer;
    requestId: string;
  }): Promise<{ status: 200 | 202; body: Record<string, unknown> }> {
    if (!UUID.test(input.connectionId)) throw refused();
    const [route] = await this.prisma.$queryRaw<Array<{ organization_id: string; provider: string }>>`
      SELECT organization_id::text, provider FROM pcp_webhook_connection(${input.connectionId}::uuid)`;
    if (!route || route.provider !== input.provider) throw refused();
    const ctx = system(route.organization_id, input.requestId);
    let payload: unknown;
    try {
      payload = JSON.parse(input.rawBody.toString('utf8') || 'null');
    } catch {
      payload = null;
    }
    const outcome = await this.runtime
      .webhook(ctx, input.connectionId, { headers: input.headers, rawBody: input.rawBody, payload })
      .catch(() => ({ verified: false as const }));
    if (!outcome.verified) {
      await withTenant(this.prisma, ctx, (tx) =>
        this.audit.record(tx, ctx, {
          action: 'webhook.rejected',
          targetType: 'connection',
          targetId: input.connectionId,
          metadata: { provider: input.provider },
        }),
      );
      throw refused();
    }
    const deliveryId = outcome.deliveryId || bodyDigest(input.rawBody);
    try {
      return await withTenant(this.prisma, ctx, async (tx) => {
        const delivery = await tx.webhookDelivery.create({
          data: {
            organizationId: ctx.organizationId,
            connectionId: input.connectionId,
            provider: input.provider,
            deliveryId,
            eventType: outcome.eventType.slice(0, 100),
            result: 'processing',
          },
        });
        let changeEvents = 0;
        let revoked = false;
        for (const o of outcome.observations) {
          if (o.resourceType === 'connection_revoked') {
            await tx.connection.updateMany({
              where: { id: input.connectionId, status: { notIn: ['disconnected', 'revoked'] } },
              data: { status: 'revoked', statusReason: 'reauthorization_required' },
            });
            revoked = true;
            continue;
          }
          if (o.resourceType !== 'change_event') continue;
          const a = o.attributes as {
            kind: string;
            title: string;
            url?: string;
            actor?: string;
            occurredAt?: string;
            externalId?: string;
          };
          const externalId = String(a.externalId ?? o.externalId ?? deliveryId).slice(0, 200);
          const { kind, title, url, actor, occurredAt, externalId: _x, ...rest } = a;
          await tx.changeEvent.upsert({
            where: { connectionId_kind_externalId: { connectionId: input.connectionId, kind, externalId } },
            create: {
              organizationId: ctx.organizationId,
              connectionId: input.connectionId,
              provider: input.provider,
              kind,
              title: String(title).slice(0, 300),
              url: url ?? null,
              actor: actor ?? null,
              externalId,
              occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
              attributes: rest as Prisma.InputJsonValue,
            },
            update: { title: String(title).slice(0, 300), attributes: rest as Prisma.InputJsonValue },
          });
          changeEvents++;
        }
        await tx.webhookDelivery.update({
          where: { id: delivery.id },
          data: { result: changeEvents || revoked ? 'processed' : 'ignored' },
        });
        return { status: 202 as const, body: { accepted: true, changeEvents } };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        return { status: 200, body: { duplicate: true } };
      throw err;
    }
  }
}
