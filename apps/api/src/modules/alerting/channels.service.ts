import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { assertPublicDestination } from '@pcp/connector-sdk';
import type { Prisma, PrismaClient } from '@pcp/database';
import { encryptSecret, serializeSecret, type KeyRing } from '@pcp/secrets';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { z } from 'zod';
import { ApiException, notFound } from '../../common/errors.js';
import { DNS_RESOLVER, KEY_RING, PRISMA } from '../../tokens.js';
import { AuditService } from '../auditing/audit.service.js';
import type { DnsResolver } from '../discovery/discovery.service.js';
import { IncidentsService } from './incidents.service.js';
import type { createChannelBody, updateChannelBody } from './schemas.js';

type ChannelRow = Prisma.NotificationChannelGetPayload<object>;

export const channelAad = (id: string) => `notification-channel:${id}`;

const view = (c: ChannelRow) => {
  const config = c.config as { recipients?: string[]; target?: string };
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    recipients: config.recipients ?? null,
    target: config.target ?? null,
    escalation: c.escalation,
    status: c.status,
    consecutiveFailures: c.consecutiveFailures,
    createdAt: c.createdAt,
  };
};

/** Email, Slack, and signed-webhook channels (WB-13 UC-13-09); secrets never leave encrypted. */
@Injectable()
export class ChannelsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(KEY_RING) private readonly keys: KeyRing,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    private readonly incidents: IncidentsService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext) {
    const rows = await withTenant(this.prisma, ctx, (tx) =>
      tx.notificationChannel.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    return { channels: rows.map(view) };
  }

  async create(ctx: TenantContext, body: z.output<typeof createChannelBody>) {
    const id = randomUUID();
    let config: Record<string, unknown>;
    let secret: string | null = null;
    let signingSecret: string | undefined;
    if (body.kind === 'email') config = { recipients: body.recipients };
    else {
      const url = await this.checkUrl(body.url);
      config = { target: url.hostname };
      signingSecret = body.kind === 'webhook' ? randomBytes(32).toString('base64url') : undefined;
      const payload = JSON.stringify({ url: url.toString(), ...(signingSecret ? { signingSecret } : {}) });
      secret = serializeSecret(encryptSecret(Buffer.from(payload), channelAad(id), this.keys.active));
    }
    const row = await withTenant(this.prisma, ctx, async (tx) => {
      const created = await tx.notificationChannel.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          name: body.name,
          kind: body.kind,
          config: config as Prisma.InputJsonValue,
          secret,
          escalation: body.escalation ?? false,
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'notification_channel.create',
        targetType: 'notification_channel',
        targetId: id,
        metadata: { kind: body.kind },
      });
      return created;
    });
    // The webhook signing secret is shown once, now; afterwards only the receiver has it.
    return { ...view(row), ...(signingSecret ? { signingSecret } : {}) };
  }

  async update(ctx: TenantContext, id: string, body: z.output<typeof updateChannelBody>) {
    const row = await withTenant(this.prisma, ctx, async (tx) => {
      const current = await tx.notificationChannel.findUnique({ where: { id } });
      if (!current) throw notFound();
      if (body.recipients && current.kind !== 'email')
        throw new ApiException(400, 'validation_failed', 'Only email channels have recipients');
      const updated = await tx.notificationChannel.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.escalation !== undefined ? { escalation: body.escalation } : {}),
          ...(body.recipients ? { config: { recipients: body.recipients } } : {}),
        },
      });
      await this.audit.record(tx, ctx, {
        action: 'notification_channel.update',
        targetType: 'notification_channel',
        targetId: id,
      });
      return updated;
    });
    return view(row);
  }

  async remove(ctx: TenantContext, id: string) {
    await withTenant(this.prisma, ctx, async (tx) => {
      const { count } = await tx.notificationChannel.deleteMany({ where: { id } });
      if (!count) throw notFound();
      await this.audit.record(tx, ctx, {
        action: 'notification_channel.delete',
        targetType: 'notification_channel',
        targetId: id,
      });
    });
  }

  /** Queues a test message; a broken channel that passes becomes active again (worker). */
  async test(ctx: TenantContext, id: string) {
    const delivery = await withTenant(this.prisma, ctx, async (tx) => {
      const channel = await tx.notificationChannel.findUnique({ where: { id }, select: { id: true } });
      if (!channel) throw notFound();
      return tx.notificationDelivery.create({
        data: { organizationId: ctx.organizationId, channelId: id, event: 'test' },
        select: { id: true },
      });
    });
    await this.incidents.queue(ctx.organizationId, [delivery.id]);
    return { deliveryId: delivery.id };
  }

  /** HTTPS to a public address only (Review Focus #3); checked again at every delivery. */
  private async checkUrl(raw: string): Promise<URL> {
    const url = new URL(raw);
    if (url.protocol !== 'https:') throw new ApiException(400, 'destination_blocked', 'Use an https:// URL');
    try {
      await assertPublicDestination(url, {
        allowPrivate: false,
        lookup: async (host) =>
          (await this.dns(host)).map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 })),
      });
    } catch (err) {
      throw new ApiException(400, 'destination_blocked', (err as Error).message);
    }
    return url;
  }
}
