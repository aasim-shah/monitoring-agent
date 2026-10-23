import { createHttpClient, type DestinationOptions } from '@pcp/connector-sdk';
import type { PrismaClient } from '@pcp/database';
import { decryptSecret, deserializeSecret } from '@pcp/secrets';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { render, type DeliveryEvent, type IncidentForMessage, type Message } from './render.js';
import { sign } from './sign.js';

/** Dead deliveries in a row after which a Slack or webhook channel is marked broken (WB-13 §9). */
export const BROKEN_AFTER = 3;

export interface DeliveryDeps {
  keyRing: Map<number, Buffer>;
  appOrigin: string;
  now(): Date;
  sendMail(mail: { to: string[]; subject: string; text: string; html: string }): Promise<void>;
  /** SSRF policy for Slack and webhook URLs; public addresses only in production. */
  destination?: DestinationOptions;
}

/** What sending needs from a channel row; secrets stay encrypted until this call. */
export interface ChannelForSend {
  id: string;
  kind: 'email' | 'slack' | 'webhook';
  config: unknown;
  secret: string | null;
}

/**
 * One message to one channel (incidents and reports): email to the configured recipients, a
 * Slack incoming webhook, or a signed JSON webhook. Throws on failure; callers record and retry.
 */
export async function sendToChannel(
  channel: ChannelForSend,
  message: Message,
  deps: DeliveryDeps,
): Promise<void> {
  if (channel.kind === 'email') {
    const recipients = (channel.config as { recipients?: string[] }).recipients ?? [];
    await deps.sendMail({ to: recipients, subject: message.subject, text: message.text, html: message.html });
    return;
  }
  const target = JSON.parse(
    decryptSecret(
      deserializeSecret(channel.secret ?? ''),
      `notification-channel:${channel.id}`,
      deps.keyRing,
    ).toString(),
  ) as { url: string; signingSecret?: string };
  const body = JSON.stringify(channel.kind === 'slack' ? message.slack : message.json);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'pcp-notifications/1',
  };
  if (channel.kind === 'webhook' && target.signingSecret)
    headers['x-pcp-signature'] = sign(target.signingSecret, body, Math.floor(deps.now().getTime() / 1000));
  const http = createHttpClient({
    destination: deps.destination ?? { allowPrivate: false },
    retries: 0,
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
  });
  const res = await http.request(target.url, { method: 'POST', headers, body });
  if (res.status < 200 || res.status >= 300) throw new Error(`receiver answered HTTP ${res.status}`);
}

/**
 * Sends one delivery (WB-13 UC-13-05). Throws on failure so the queue retries (5 attempts,
 * exponential backoff); `final` marks the last attempt, which dead-letters the delivery and
 * counts against the channel. Network calls happen outside any database transaction.
 */
export async function processDelivery(
  prisma: PrismaClient,
  ctx: TenantContext,
  deliveryId: string,
  final: boolean,
  deps: DeliveryDeps,
): Promise<{ sent: true } | { skipped: string }> {
  const loaded = await withTenant(prisma, ctx, async (tx) => {
    const delivery = await tx.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: { channel: true, incident: true },
    });
    return delivery && delivery.status !== 'sent' && delivery.status !== 'dead' ? delivery : null;
  });
  if (!loaded) return { skipped: 'delivery or channel gone' };
  const { channel, incident } = loaded;
  const link = incident
    ? `${deps.appOrigin}/orgs/${ctx.organizationId}/products/${incident.productId}/incidents/${incident.id}`
    : deps.appOrigin;
  const message = render(loaded.event as DeliveryEvent, incident as IncidentForMessage | null, link);
  try {
    await sendToChannel(channel, message, deps);
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await withTenant(prisma, ctx, async (tx) => {
      await tx.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: final ? 'dead' : 'failed', attempts: { increment: 1 }, lastError: error },
      });
      if (final) {
        const ch = await tx.notificationChannel.update({
          where: { id: channel.id },
          data: { consecutiveFailures: { increment: 1 } },
        });
        if (ch.kind !== 'email' && ch.consecutiveFailures >= BROKEN_AFTER)
          await tx.notificationChannel.update({ where: { id: channel.id }, data: { status: 'broken' } });
      }
    });
    throw err;
  }
  await withTenant(prisma, ctx, async (tx) => {
    await tx.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: 'sent', attempts: { increment: 1 }, sentAt: deps.now(), lastError: null },
    });
    await tx.notificationChannel.update({
      where: { id: channel.id },
      data: { consecutiveFailures: 0, status: 'active' },
    });
  });
  return { sent: true };
}
