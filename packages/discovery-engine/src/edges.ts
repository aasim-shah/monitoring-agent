import type { Prisma } from '@pcp/database';

type Tx = Prisma.TransactionClient;
export type RelationshipType =
  | 'HOSTS'
  | 'ROUTES_TO'
  | 'CONNECTS_TO'
  | 'DEPENDS_ON'
  | 'DEPLOYS'
  | 'MONITORED_BY'
  | 'REPORTS_TO'
  | 'DEPLOYED_ON';
export type Verification = 'proposed' | 'verified' | 'rejected' | 'drifted';
export type EvidenceKind = 'direct' | 'ip_match' | 'connection' | 'name' | 'manual' | 'contradiction';

/** Pinned confidences (master plan M9.2). */
export const CONFIDENCE = {
  directFact: 0.95,
  ipMatch: 0.8,
  connection: 0.6,
  connectionShared: 0.4,
  nameOnly: 0.3,
} as const;

export interface EdgeProposal {
  source: string;
  target: string;
  type: RelationshipType;
  confidence: number;
  evidenceKind: EvidenceKind;
  /** Observed directly (agent/provider fact), not inferred. */
  direct: boolean;
  detail?: Record<string, unknown>;
  ruleId: string;
}

const KEEP_EVIDENCE = 20;

/**
 * UC-10-03: create or strengthen an edge. Auto-verified only at ≥ 0.9 with direct
 * observation (BR-10-03). A rejected edge comes back as `proposed` only on strong direct
 * evidence; a drifted edge waits for a person to re-confirm.
 */
export async function proposeEdge(
  tx: Tx,
  organizationId: string,
  e: EdgeProposal,
): Promise<{ id: string; verification: Verification; created: boolean }> {
  if (e.source === e.target) throw new Error('an edge needs two different assets');
  const strong = e.confidence >= 0.9 && e.direct;
  const existing = await tx.assetRelationship.findUnique({
    where: {
      sourceAssetId_targetAssetId_relationshipType: {
        sourceAssetId: e.source,
        targetAssetId: e.target,
        relationshipType: e.type,
      },
    },
  });
  let id: string;
  let verification: Verification;
  let created = false;
  if (!existing) {
    verification = strong ? 'verified' : 'proposed';
    const row = await tx.assetRelationship.create({
      data: {
        organizationId,
        sourceAssetId: e.source,
        targetAssetId: e.target,
        relationshipType: e.type,
        confidence: e.confidence,
        verification,
        ruleId: e.ruleId,
      },
    });
    id = row.id;
    created = true;
  } else {
    id = existing.id;
    const current = existing.verification as Verification;
    verification =
      current === 'rejected'
        ? strong
          ? 'proposed'
          : 'rejected'
        : current === 'proposed' && strong
          ? 'verified'
          : current;
    await tx.assetRelationship.update({
      where: { id },
      data: { confidence: Math.max(Number(existing.confidence), e.confidence), verification },
    });
  }
  await tx.relationshipEvidence.create({
    data: {
      organizationId,
      relationshipId: id,
      kind: e.evidenceKind,
      detail: { ...(e.detail ?? {}), ruleId: e.ruleId, confidence: e.confidence } as Prisma.InputJsonValue,
    },
  });
  const old = await tx.relationshipEvidence.findMany({
    where: { relationshipId: id },
    orderBy: { observedAt: 'desc' },
    skip: KEEP_EVIDENCE,
    select: { id: true },
  });
  if (old.length) await tx.relationshipEvidence.deleteMany({ where: { id: { in: old.map((x) => x.id) } } });
  return { id, verification, created };
}

/** BR-10-04: contradicting evidence drifts a verified edge; nothing is deleted. */
export async function contradictEdge(
  tx: Tx,
  organizationId: string,
  relationshipId: string,
  detail: Record<string, unknown>,
): Promise<Verification> {
  const edge = await tx.assetRelationship.findUniqueOrThrow({ where: { id: relationshipId } });
  const verification: Verification =
    edge.verification === 'verified' ? 'drifted' : (edge.verification as Verification);
  await tx.assetRelationship.update({ where: { id: relationshipId }, data: { verification } });
  await tx.relationshipEvidence.create({
    data: { organizationId, relationshipId, kind: 'contradiction', detail: detail as Prisma.InputJsonValue },
  });
  return verification;
}
