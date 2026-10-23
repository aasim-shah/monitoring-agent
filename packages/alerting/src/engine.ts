import { createHash } from 'node:crypto';
import type { Prisma } from '@pcp/database';
import { computeImpact, type ImpactedAsset } from '@pcp/discovery-engine';

type Tx = Prisma.TransactionClient;

/** Master plan §3 alerting values. */
export const COOLDOWN_MS = 30 * 60_000;
export const REOPEN_WINDOW_MS = 30 * 60_000;
export const ESCALATE_AFTER_MS = 15 * 60_000;
/** A still-firing alert adds a `refired` event at most this often (no event storm). */
const REFIRE_EVENT_EVERY_MS = 5 * 60_000;
const MAX_CORRELATED = 20;

/** Labels that vary per evaluation or carry no identity. */
const VOLATILE_LABELS = new Set(['alertname', 'alertgroup']);

export interface NormalizedAlert {
  ruleId: string;
  labels: Record<string, string>;
  status: 'firing' | 'resolved';
  startsAt: Date;
  endsAt?: Date;
  value?: string;
}

export type NotifyEvent = 'opened' | 'resolved' | 'escalated';

export interface NotifyRequest {
  incidentId: string;
  event: NotifyEvent;
}

export interface IngestResult {
  opened: string[];
  reopened: string[];
  updated: string[];
  resolved: string[];
  notify: NotifyRequest[];
}

export interface Correlation {
  host: { id: string; name: string } | null;
  assets: Array<Pick<ImpactedAsset, 'assetId' | 'name' | 'assetType' | 'impact' | 'distance'>>;
  counts: Record<'confirmed' | 'potential' | 'unknown', number>;
}

/** sha256(tenant, rule, sorted labels) without volatile labels (BR-13-02). */
export function fingerprint(organizationId: string, ruleId: string, labels: Record<string, string>): string {
  const stable = Object.entries(labels)
    .filter(([k]) => !VOLATILE_LABELS.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return createHash('sha256')
    .update([organizationId, ruleId, ...stable].join('\n'))
    .digest('hex');
}

/**
 * Turns alerts into incidents inside the caller's tenant transaction (WB-13 UC-13-04/05/08).
 * Alerts for rules this tenant cannot see are skipped. Notifications respect the 30-minute
 * cooldown per incident; the timeline always records what happened (BR-13-04).
 */
export async function ingest(
  tx: Tx,
  organizationId: string,
  alerts: NormalizedAlert[],
  now: Date,
): Promise<IngestResult> {
  const result: IngestResult = { opened: [], reopened: [], updated: [], resolved: [], notify: [] };
  const rules = new Map(
    (
      await tx.alertRule.findMany({
        where: { id: { in: [...new Set(alerts.map((a) => a.ruleId))] } },
        select: { id: true, name: true, productId: true, severity: true },
      })
    ).map((r) => [r.id, r]),
  );
  for (const alert of alerts) {
    const rule = rules.get(alert.ruleId);
    if (!rule) continue;
    const fp = fingerprint(organizationId, rule.id, alert.labels);
    const open = await tx.alertIncident.findUnique({
      where: { organizationId_openFingerprint: { organizationId, openFingerprint: fp } },
    });
    if (alert.status === 'resolved') {
      if (!open) continue;
      await tx.alertIncident.update({
        where: { id: open.id },
        data: {
          status: 'resolved',
          openFingerprint: null,
          resolvedAt: now,
          resolutionNote: 'Condition cleared',
        },
      });
      await event(tx, organizationId, open.id, 'resolved', { by: 'alert' }, now);
      result.resolved.push(open.id);
      if (await hasUnansweredOpeningNotice(tx, open.id))
        await notify(tx, organizationId, open.id, 'resolved', now, result);
      continue;
    }
    if (open) {
      if (now.getTime() - open.lastFiredAt.getTime() >= REFIRE_EVENT_EVERY_MS) {
        await tx.alertIncident.update({ where: { id: open.id }, data: { lastFiredAt: now } });
        await event(tx, organizationId, open.id, 'refired', { value: alert.value ?? null }, now);
        result.updated.push(open.id);
      }
      continue;
    }
    const recent = await tx.alertIncident.findFirst({
      where: {
        fingerprint: fp,
        status: 'resolved',
        resolvedAt: { gt: new Date(now.getTime() - REOPEN_WINDOW_MS) },
      },
      orderBy: { resolvedAt: 'desc' },
    });
    if (recent) {
      await tx.alertIncident.update({
        where: { id: recent.id },
        data: {
          status: 'open',
          openFingerprint: fp,
          resolvedAt: null,
          resolutionNote: null,
          acknowledgedAt: null,
          acknowledgedByUserId: null,
          lastFiredAt: now,
        },
      });
      await event(tx, organizationId, recent.id, 'reopened', { value: alert.value ?? null }, now);
      result.reopened.push(recent.id);
      await notifyOpening(tx, organizationId, recent.id, recent.lastNotifiedAt, now, result);
      continue;
    }
    const correlation = await correlate(tx, alert.labels, rule.productId, now);
    const where = target(alert.labels, correlation);
    const title = `${rule.name} on ${where}`;
    const incident = await tx.alertIncident.create({
      data: {
        organizationId,
        productId: rule.productId,
        ruleId: rule.id,
        fingerprint: fp,
        openFingerprint: fp,
        title,
        severity: rule.severity,
        labels: alert.labels,
        correlation: correlation as unknown as Prisma.InputJsonValue,
        summary: summarize(title, alert.value, correlation),
        startedAt: alert.startsAt,
        lastFiredAt: now,
      },
    });
    await event(tx, organizationId, incident.id, 'fired', { value: alert.value ?? null }, now);
    result.opened.push(incident.id);
    await notifyOpening(tx, organizationId, incident.id, null, now, result);
  }
  return result;
}

/** Stops escalation; only an open incident can be acknowledged (UC-13-06). */
export async function acknowledge(tx: Tx, incidentId: string, userId: string, now: Date): Promise<void> {
  const { count } = await tx.alertIncident.updateMany({
    where: { id: incidentId, status: 'open' },
    data: { status: 'acknowledged', acknowledgedAt: now, acknowledgedByUserId: userId },
  });
  if (!count) throw new Error('incident is not open');
  const incident = await tx.alertIncident.findUniqueOrThrow({ where: { id: incidentId } });
  await event(tx, incident.organizationId, incidentId, 'acknowledged', { userId }, now);
}

/** Manual resolution with a note (UC-13-08). */
export async function resolveManually(
  tx: Tx,
  incidentId: string,
  userId: string,
  note: string,
  now: Date,
): Promise<void> {
  const { count } = await tx.alertIncident.updateMany({
    where: { id: incidentId, status: { not: 'resolved' } },
    data: { status: 'resolved', openFingerprint: null, resolvedAt: now, resolutionNote: note },
  });
  if (!count) throw new Error('incident is already resolved');
  const incident = await tx.alertIncident.findUniqueOrThrow({ where: { id: incidentId } });
  await event(tx, incident.organizationId, incidentId, 'resolved', { by: 'user', userId, note }, now);
}

/** Critical incidents still open (not acknowledged) after 15 minutes escalate once (BR-13-05). */
export async function escalate(tx: Tx, now: Date): Promise<NotifyRequest[]> {
  const due = await tx.alertIncident.findMany({
    where: {
      severity: 'critical',
      status: 'open',
      escalatedAt: null,
      startedAt: { lte: new Date(now.getTime() - ESCALATE_AFTER_MS) },
    },
    select: { id: true, organizationId: true },
  });
  const out: NotifyRequest[] = [];
  for (const i of due) {
    await tx.alertIncident.update({ where: { id: i.id }, data: { escalatedAt: now, lastNotifiedAt: now } });
    await event(tx, i.organizationId, i.id, 'escalated', {}, now);
    await event(tx, i.organizationId, i.id, 'notified', { event: 'escalated' }, now);
    out.push({ incidentId: i.id, event: 'escalated' });
  }
  return out;
}

async function notifyOpening(
  tx: Tx,
  organizationId: string,
  incidentId: string,
  lastNotifiedAt: Date | null,
  now: Date,
  result: IngestResult,
) {
  if (lastNotifiedAt && now.getTime() - lastNotifiedAt.getTime() < COOLDOWN_MS) {
    await event(tx, organizationId, incidentId, 'suppressed', { reason: 'cooldown' }, now);
    return;
  }
  await notify(tx, organizationId, incidentId, 'opened', now, result);
}

async function notify(
  tx: Tx,
  organizationId: string,
  incidentId: string,
  kind: NotifyEvent,
  now: Date,
  result: IngestResult,
) {
  await tx.alertIncident.update({ where: { id: incidentId }, data: { lastNotifiedAt: now } });
  await event(tx, organizationId, incidentId, 'notified', { event: kind }, now);
  result.notify.push({ incidentId, event: kind });
}

/** A resolution notice answers an opening or escalation notice that has not been answered yet. */
async function hasUnansweredOpeningNotice(tx: Tx, incidentId: string): Promise<boolean> {
  const last = await tx.incidentEvent.findFirst({
    where: { incidentId, kind: 'notified' },
    orderBy: { at: 'desc' },
    select: { detail: true },
  });
  const sent = (last?.detail as { event?: string } | undefined)?.event;
  return sent === 'opened' || sent === 'escalated';
}

function event(
  tx: Tx,
  organizationId: string,
  incidentId: string,
  kind: Prisma.IncidentEventCreateInput['kind'],
  detail: Record<string, unknown>,
  at: Date,
) {
  return tx.incidentEvent.create({
    data: { organizationId, incidentId, kind, detail: detail as Prisma.InputJsonValue, at },
  });
}

/** The host asset of the alert's agent and what depends on it (spec §13.2 correlation). */
async function correlate(
  tx: Tx,
  labels: Record<string, string>,
  productId: string | null,
  now: Date,
): Promise<Correlation> {
  const empty: Correlation = { host: null, assets: [], counts: { confirmed: 0, potential: 0, unknown: 0 } };
  if (!labels.agent_id) return empty;
  const host = await tx.asset.findFirst({
    where: { identityKey: `agent:${labels.agent_id}` },
    select: { id: true, name: true },
  });
  if (!host) return empty;
  const impacted = await computeImpact(tx, host.id, {
    products: productId ? [productId] : null,
    depth: 4,
    now,
  });
  const counts = { confirmed: 0, potential: 0, unknown: 0 };
  for (const a of impacted) counts[a.impact]++;
  return {
    host,
    assets: impacted.slice(0, MAX_CORRELATED).map(({ assetId, name, assetType, impact, distance }) => ({
      assetId,
      name,
      assetType,
      impact,
      distance,
    })),
    counts,
  };
}

function target(labels: Record<string, string>, c: Correlation): string {
  const host = c.host?.name ?? labels.agent_id ?? labels.connection_name ?? 'this organization';
  const detail = labels.mountpoint ?? labels.service;
  return detail ? `${host} (${detail})` : host;
}

/** Deterministic wording: "correlated with", never a cause (BR-13-03). */
export function summarize(title: string, value: string | undefined, c: Correlation): string {
  const n = value === undefined ? NaN : Number(value);
  const now = Number.isFinite(n) ? ` Latest value ${n.toFixed(1)}.` : '';
  const related = c.assets.length
    ? ` Correlated with ${c.assets.length} asset${c.assets.length === 1 ? '' : 's'}: ${c.assets
        .map((a) => `${a.name} (${a.impact})`)
        .join(', ')}.`
    : ' No related assets are known in the asset graph yet.';
  return `${title}.${now}${related}`;
}
