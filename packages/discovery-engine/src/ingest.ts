import { randomUUID } from 'node:crypto';
import type { Prisma } from '@pcp/database';
import { redactAttributes } from './redact.js';

type Tx = Prisma.TransactionClient;
export type AssetSource = 'agent' | 'connector' | 'product_config' | 'manual';
export type AssetType =
  | 'host'
  | 'service'
  | 'database'
  | 'website'
  | 'domain'
  | 'repository'
  | 'worker'
  | 'external';

export interface Observation {
  source: AssetSource;
  assetType: AssetType;
  /** Stable: provider ID or agent identity. Weak: a name or IP only (never merged, BR-10-02). */
  identity: { kind: 'stable'; key: string } | { kind: 'weak'; name: string; ip?: string };
  name: string;
  attributes?: Record<string, unknown>;
  productId?: string;
  environmentId?: string;
}

export interface IngestResult {
  assetId: string;
  created: boolean;
  aliasCandidateId?: string;
}

/** Types whose names are identity hints (a second "vps-1" deserves review); services repeat by design. */
const ALIASED_TYPES = new Set(['host', 'website', 'domain', 'repository']);
const KEEP_OBSERVATIONS = 20;

/**
 * UC-10-01: validate + redact, normalize, match, upsert. Matching is by stable identity
 * within the organization only (BR-10-01); a name or IP match never merges, it creates an
 * alias candidate for review (BR-10-02). Runs inside the caller's tenant transaction.
 */
export async function ingestObservation(
  tx: Tx,
  organizationId: string,
  o: Observation,
): Promise<IngestResult> {
  const attributes = redactAttributes(o.attributes ?? {}) as Prisma.InputJsonValue;
  const name = o.name.trim().slice(0, 256) || 'unnamed';
  const now = new Date();
  let assetId: string;
  let created = false;
  let aliasCandidateId: string | undefined;

  let existing =
    o.identity.kind === 'stable'
      ? await tx.asset.findUnique({
          where: { organizationId_identityKey: { organizationId, identityKey: o.identity.key } },
        })
      : null;
  // A reviewer merged this identity into another asset: keep feeding that one (UC-10-02).
  const mergedInto = (existing?.attributes as Record<string, unknown> | null)?.mergedInto;
  let redirected = false;
  if (existing?.lifecycle === 'retired' && typeof mergedInto === 'string') {
    const target = await tx.asset.findUnique({ where: { id: mergedInto } });
    if (target) {
      existing = target;
      redirected = true;
    }
  }
  if (existing) {
    assetId = existing.id;
    await tx.asset.update({
      where: { id: existing.id },
      data: {
        // A merged identity keeps the reviewed asset's name and attributes.
        ...(redirected ? {} : { name, attributes }),
        lastSeenAt: now,
        missedRuns: 0,
        ...(['discovered', 'missing', 'unreachable'].includes(existing.lifecycle)
          ? { lifecycle: 'active' }
          : {}),
      },
    });
  } else {
    const asset = await tx.asset.create({
      data: {
        organizationId,
        assetType: o.assetType,
        name,
        source: o.source,
        identityKey: o.identity.kind === 'stable' ? o.identity.key : `weak:${randomUUID()}`,
        attributes,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    assetId = asset.id;
    created = true;
    if (ALIASED_TYPES.has(o.assetType) || o.identity.kind === 'weak') {
      const ip = o.identity.kind === 'weak' ? o.identity.ip : undefined;
      const twin = await tx.asset.findFirst({
        where: {
          id: { not: assetId },
          assetType: o.assetType,
          lifecycle: { not: 'retired' },
          OR: [
            { name: { equals: name, mode: 'insensitive' } },
            ...(ip ? [{ attributes: { path: ['ip'], equals: ip } }] : []),
          ],
        },
        orderBy: { firstSeenAt: 'asc' },
      });
      if (twin) {
        const alias = await tx.assetAlias.create({
          data: {
            organizationId,
            assetId,
            candidateAssetId: twin.id,
            reason:
              ip && twin.name.toLowerCase() !== name.toLowerCase() ? `same IP ${ip}` : `same name "${name}"`,
          },
        });
        aliasCandidateId = alias.id;
      }
    }
  }

  await tx.assetObservation.create({
    data: { organizationId, assetId, source: o.source, observedAt: now, attributes },
  });
  const old = await tx.assetObservation.findMany({
    where: { assetId },
    orderBy: { observedAt: 'desc' },
    skip: KEEP_OBSERVATIONS,
    select: { id: true },
  });
  if (old.length) await tx.assetObservation.deleteMany({ where: { id: { in: old.map((x) => x.id) } } });

  if (o.productId)
    await tx.productAsset.upsert({
      where: { productId_assetId: { productId: o.productId, assetId } },
      create: { organizationId, productId: o.productId, assetId, environmentId: o.environmentId ?? null },
      update: o.environmentId ? { environmentId: o.environmentId } : {},
    });
  return { assetId, created, ...(aliasCandidateId ? { aliasCandidateId } : {}) };
}
