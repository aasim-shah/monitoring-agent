import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import { ApiException, notFound } from '../../common/errors.js';
import { CLOCK, PRISMA } from '../../tokens.js';
import { agentStatus } from '../agents/status.js';
import { AuditService } from '../auditing/audit.service.js';

type Tx = Prisma.TransactionClient;
type AssetRow = Prisma.AssetGetPayload<{ include: { products: { select: { productId: true } } } }>;

export const RELATIONSHIP_TYPES = [
  'HOSTS',
  'ROUTES_TO',
  'CONNECTS_TO',
  'DEPENDS_ON',
  'DEPLOYS',
  'MONITORED_BY',
  'REPORTS_TO',
  'DEPLOYED_ON',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** Impact walks from an asset to what depends on it: these edges point dependent → dependency… */
const DEPENDS_TYPES = ['ROUTES_TO', 'DEPENDS_ON', 'CONNECTS_TO', 'DEPLOYED_ON'];
/** …and HOSTS points dependency → dependent. */
const HOSTS_TYPE = 'HOSTS';

export type ImpactClass = 'confirmed' | 'potential' | 'unknown';

const relationshipInclude = {
  source: { select: { id: true, name: true, assetType: true } },
  target: { select: { id: true, name: true, assetType: true } },
  evidence: { orderBy: { observedAt: 'desc' as const }, take: 5 },
} satisfies Prisma.AssetRelationshipInclude;
type RelationshipRow = Prisma.AssetRelationshipGetPayload<{ include: typeof relationshipInclude }>;

/**
 * The asset graph for people (WB-10 §7). Product scope (D7, Review Focus #5): an asset is
 * visible when linked to one of the caller's products; an edge only when both ends are.
 * Anything invisible is reported as not found, never by name, ID, or count.
 */
@Injectable()
export class AssetsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
    private readonly audit: AuditService,
  ) {}

  private visible(ctx: TenantContext): Prisma.AssetWhereInput {
    return ctx.productIds === 'all' ? {} : { products: { some: { productId: { in: ctx.productIds } } } };
  }

  private async assertVisible(tx: Tx, ctx: TenantContext, ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    const n = await tx.asset.count({ where: { id: { in: unique }, ...this.visible(ctx) } });
    if (n !== unique.length) throw notFound();
  }

  private assetView(a: AssetRow, ctx: TenantContext) {
    const productIds = a.products
      .map((p) => p.productId)
      .filter((p) => ctx.productIds === 'all' || ctx.productIds.includes(p));
    return {
      id: a.id,
      assetType: a.assetType,
      name: a.name,
      lifecycle: a.lifecycle,
      source: a.source,
      attributes: a.attributes,
      firstSeenAt: a.firstSeenAt,
      lastSeenAt: a.lastSeenAt,
      productIds,
    };
  }

  private relationshipView(r: RelationshipRow) {
    return {
      id: r.id,
      type: r.relationshipType,
      verification: r.verification,
      confidence: Number(r.confidence),
      ruleId: r.ruleId,
      source: r.source,
      target: r.target,
      evidence: r.evidence.map((e) => ({ kind: e.kind, detail: e.detail, observedAt: e.observedAt })),
      updatedAt: r.updatedAt,
    };
  }

  // ----- reads -----

  list(
    ctx: TenantContext,
    productId: string,
    filters: { type?: string; lifecycle?: string; source?: string },
  ) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const rows = await tx.asset.findMany({
        where: {
          products: { some: { productId } },
          lifecycle: filters.lifecycle ? (filters.lifecycle as never) : { not: 'retired' },
          ...(filters.type ? { assetType: filters.type as never } : {}),
          ...(filters.source ? { source: filters.source as never } : {}),
        },
        include: { products: { select: { productId: true } } },
        orderBy: [{ assetType: 'asc' }, { name: 'asc' }],
        take: 2000,
      });
      return rows.map((a) => this.assetView(a, ctx));
    });
  }

  get(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const a = await tx.asset.findFirst({
        where: { id, ...this.visible(ctx) },
        include: {
          products: { select: { productId: true } },
          observations: { orderBy: { observedAt: 'desc' }, take: 5 },
        },
      });
      if (!a) throw notFound();
      return {
        ...this.assetView(a, ctx),
        observations: a.observations.map((o) => ({
          source: o.source,
          observedAt: o.observedAt,
          attributes: o.attributes,
        })),
      };
    });
  }

  relationships(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      await this.assertVisible(tx, ctx, [id]);
      const rows = await tx.assetRelationship.findMany({
        where: {
          OR: [
            { sourceAssetId: id, target: this.visible(ctx) },
            { targetAssetId: id, source: this.visible(ctx) },
          ],
        },
        include: relationshipInclude,
        orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({
        ...this.relationshipView(r),
        direction: r.sourceAssetId === id ? ('outgoing' as const) : ('incoming' as const),
        other: r.sourceAssetId === id ? r.target : r.source,
      }));
    });
  }

  /** Nodes and edges of a product; rejected edges are left out. */
  topology(ctx: TenantContext, productId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const nodes = await tx.asset.findMany({
        where: { products: { some: { productId } }, lifecycle: { not: 'retired' }, ...this.visible(ctx) },
        select: { id: true, name: true, assetType: true, lifecycle: true },
        take: 2000,
      });
      const ids = nodes.map((n) => n.id);
      const edges = await tx.assetRelationship.findMany({
        where: { sourceAssetId: { in: ids }, targetAssetId: { in: ids }, verification: { not: 'rejected' } },
        select: {
          id: true,
          sourceAssetId: true,
          targetAssetId: true,
          relationshipType: true,
          verification: true,
          confidence: true,
        },
      });
      return {
        nodes,
        edges: edges.map((e) => ({
          id: e.id,
          source: e.sourceAssetId,
          target: e.targetAssetId,
          type: e.relationshipType,
          verification: e.verification,
          confidence: Number(e.confidence),
        })),
      };
    });
  }

  /** Proposed and drifted edges, and open alias candidates, for a product's review queue. */
  review(ctx: TenantContext, productId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const inProduct: Prisma.AssetWhereInput = { products: { some: { productId } }, ...this.visible(ctx) };
      const edges = await tx.assetRelationship.findMany({
        where: { verification: { in: ['proposed', 'drifted'] }, source: inProduct, target: inProduct },
        include: relationshipInclude,
        orderBy: [{ verification: 'asc' }, { confidence: 'desc' }],
        take: 500,
      });
      const aliases = await tx.assetAlias.findMany({
        where: { status: 'open', asset: inProduct, candidate: this.visible(ctx) },
        include: {
          asset: { select: { id: true, name: true, assetType: true, attributes: true } },
          candidate: { select: { id: true, name: true, assetType: true, attributes: true } },
        },
        take: 200,
      });
      return {
        edges: edges.map((r) => this.relationshipView(r)),
        aliases: aliases.map((a) => ({
          id: a.id,
          reason: a.reason,
          asset: a.asset,
          candidate: a.candidate,
          createdAt: a.createdAt,
        })),
      };
    });
  }

  coverage(ctx: TenantContext, productId: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const assets = await tx.asset.findMany({
        where: { products: { some: { productId } }, lifecycle: { not: 'retired' }, ...this.visible(ctx) },
        select: { id: true, assetType: true, lifecycle: true, lastSeenAt: true },
      });
      const ids = assets.map((a) => a.id);
      const edges = await tx.assetRelationship.groupBy({
        by: ['verification'],
        where: { sourceAssetId: { in: ids }, targetAssetId: { in: ids } },
        _count: { _all: true },
      });
      const count = <K extends string>(keys: K[]) =>
        keys.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
      const staleBefore = this.now().getTime() - 24 * 3600_000;
      return {
        assets: assets.length,
        byLifecycle: count(assets.map((a) => a.lifecycle)),
        byType: count(assets.map((a) => a.assetType)),
        edges: Object.fromEntries(edges.map((e) => [e.verification, e._count._all])),
        stale: assets.filter(
          (a) => a.lifecycle !== 'manually_managed' && a.lastSeenAt.getTime() < staleBefore,
        ).length,
      };
    });
  }

  /**
   * Blast radius (UC-10-10): walks to dependents up to `depth` (default 4, max 6) through
   * visible assets only, skipping rejected edges and cycles.
   * confirmed = the dependent's own health is failing; potential = reached through verified
   * or ≥ 0.8 edges; unknown = otherwise (BR-10-07: a dependency alone proves no outage).
   */
  impact(ctx: TenantContext, assetId: string, depthParam?: number) {
    const depth = Math.min(Math.max(Math.trunc(depthParam ?? 4) || 4, 1), 6);
    const products = ctx.productIds === 'all' ? null : ctx.productIds;
    return withTenant(this.prisma, ctx, async (tx) => {
      await this.assertVisible(tx, ctx, [assetId]);
      const rows = await tx.$queryRaw<
        Array<{ asset_id: string; distance: number; path: string[]; min_conf: number; all_verified: boolean }>
      >`
        WITH RECURSIVE visible AS (
          SELECT a.id FROM assets a
          WHERE a.lifecycle <> 'retired'
            AND (${products}::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM product_assets pa WHERE pa.asset_id = a.id AND pa.product_id = ANY(${products}::uuid[])))
        ),
        walk (asset_id, distance, path, min_conf, all_verified) AS (
          SELECT ${assetId}::uuid, 0, ARRAY[${assetId}::uuid], 1.0::numeric, true
          UNION ALL
          SELECT e.dep, w.distance + 1, w.path || e.dep, LEAST(w.min_conf, e.confidence), w.all_verified AND e.verification = 'verified'
          FROM walk w
          JOIN LATERAL (
            SELECT CASE WHEN r.relationship_type = ${HOSTS_TYPE}::relationship_type THEN r.target_asset_id ELSE r.source_asset_id END AS dep,
                   r.confidence, r.verification
            FROM asset_relationships r
            WHERE r.verification <> 'rejected'
              AND ((r.relationship_type::text = ANY(${DEPENDS_TYPES}::text[]) AND r.target_asset_id = w.asset_id)
                OR (r.relationship_type = ${HOSTS_TYPE}::relationship_type AND r.source_asset_id = w.asset_id))
          ) e ON true
          JOIN visible v ON v.id = e.dep
          WHERE w.distance < ${depth} AND NOT e.dep = ANY(w.path)
        )
        SELECT DISTINCT ON (asset_id) asset_id::text, distance, path::text[] AS path, min_conf::float AS min_conf, all_verified
        FROM walk WHERE distance > 0
        ORDER BY asset_id, (all_verified OR min_conf >= 0.8) DESC, distance ASC`;
      if (rows.length === 0) return [];
      const ids = [...new Set(rows.flatMap((r) => r.path))];
      const assets = await tx.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, assetType: true, attributes: true },
      });
      const byId = new Map(assets.map((a) => [a.id, a]));
      const failing = await this.failingAssets(tx, rows.map((r) => byId.get(r.asset_id)!).filter(Boolean));
      return rows
        .map((r) => {
          const a = byId.get(r.asset_id)!;
          const impact: ImpactClass = failing.has(a.id)
            ? 'confirmed'
            : r.all_verified || r.min_conf >= 0.8
              ? 'potential'
              : 'unknown';
          return {
            assetId: a.id,
            name: a.name,
            assetType: a.assetType,
            distance: r.distance,
            impact,
            via: r.path.map((p) => byId.get(p)?.name ?? ''),
          };
        })
        .sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name));
    });
  }

  /** Dependents whose own health is failing: a database's latest check, or an agent that stopped reporting. */
  private async failingAssets(tx: Tx, assets: Array<{ id: string; attributes: Prisma.JsonValue }>) {
    const failing = new Set<string>();
    for (const a of assets) {
      const attrs = (a.attributes ?? {}) as Record<string, unknown>;
      if (typeof attrs.connectionId === 'string') {
        const latest = await tx.connectionHealth.findFirst({
          where: { connectionId: attrs.connectionId },
          orderBy: { checkedAt: 'desc' },
          select: { ok: true },
        });
        if (latest && !latest.ok) failing.add(a.id);
      } else if (typeof attrs.agentId === 'string') {
        const agent = await tx.agent.findUnique({
          where: { id: attrs.agentId },
          select: { status: true, lastHeartbeatAt: true, createdAt: true },
        });
        if (agent && agentStatus(agent, this.now()).status !== 'active') failing.add(a.id);
      }
    }
    return failing;
  }

  // ----- writes -----

  private async loadRelationship(tx: Tx, ctx: TenantContext, id: string) {
    const r = await tx.assetRelationship.findUnique({ where: { id }, include: relationshipInclude });
    if (!r) throw notFound();
    await this.assertVisible(tx, ctx, [r.sourceAssetId, r.targetAssetId]);
    return r;
  }

  private userId(ctx: TenantContext) {
    return ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  }

  setVerification(ctx: TenantContext, id: string, verification: 'verified' | 'rejected') {
    return withTenant(this.prisma, ctx, async (tx) => {
      const r = await this.loadRelationship(tx, ctx, id);
      await tx.assetRelationship.update({
        where: { id },
        data: { verification, verifiedByUserId: this.userId(ctx) },
      });
      await tx.relationshipEvidence.create({
        data: {
          organizationId: ctx.organizationId,
          relationshipId: id,
          kind: 'manual',
          detail: { action: verification },
        },
      });
      await this.audit.record(tx, ctx, {
        action: `relationship.${verification}`,
        targetType: 'relationship',
        targetId: id,
        metadata: {
          type: r.relationshipType,
          source: r.sourceAssetId,
          target: r.targetAssetId,
          from: r.verification,
        },
      });
      return this.relationshipView(
        await tx.assetRelationship.findUniqueOrThrow({ where: { id }, include: relationshipInclude }),
      );
    });
  }

  private async upsertManualEdge(
    tx: Tx,
    ctx: TenantContext,
    source: string,
    target: string,
    type: RelationshipType,
    detail: Record<string, unknown>,
  ) {
    if (source === target)
      throw new ApiException(400, 'validation_failed', 'An edge needs two different assets');
    const edge = await tx.assetRelationship.upsert({
      where: {
        sourceAssetId_targetAssetId_relationshipType: {
          sourceAssetId: source,
          targetAssetId: target,
          relationshipType: type,
        },
      },
      create: {
        organizationId: ctx.organizationId,
        sourceAssetId: source,
        targetAssetId: target,
        relationshipType: type,
        confidence: 1,
        verification: 'verified',
        ruleId: 'manual',
        verifiedByUserId: this.userId(ctx),
      },
      update: { verification: 'verified', confidence: 1, verifiedByUserId: this.userId(ctx) },
    });
    await tx.relationshipEvidence.create({
      data: {
        organizationId: ctx.organizationId,
        relationshipId: edge.id,
        kind: 'manual',
        detail: detail as Prisma.InputJsonValue,
      },
    });
    return edge;
  }

  /** UC-10-05: a person states an edge; it is verified with manual evidence. */
  createRelationship(
    ctx: TenantContext,
    sourceId: string,
    input: { targetAssetId: string; type: RelationshipType },
  ) {
    return withTenant(this.prisma, ctx, async (tx) => {
      await this.assertVisible(tx, ctx, [sourceId, input.targetAssetId]);
      const edge = await this.upsertManualEdge(tx, ctx, sourceId, input.targetAssetId, input.type, {
        action: 'created',
      });
      await this.audit.record(tx, ctx, {
        action: 'relationship.created',
        targetType: 'relationship',
        targetId: edge.id,
        metadata: { type: input.type, source: sourceId, target: input.targetAssetId },
      });
      return this.relationshipView(
        await tx.assetRelationship.findUniqueOrThrow({
          where: { id: edge.id },
          include: relationshipInclude,
        }),
      );
    });
  }

  /** UC-10-06: the old edge is rejected and the corrected one verified; both audited. */
  correct(ctx: TenantContext, id: string, input: { targetAssetId?: string; type?: RelationshipType }) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const r = await this.loadRelationship(tx, ctx, id);
      const target = input.targetAssetId ?? r.targetAssetId;
      const type = (input.type ?? r.relationshipType) as RelationshipType;
      if (target === r.targetAssetId && type === r.relationshipType)
        throw new ApiException(400, 'validation_failed', 'The correction changes nothing');
      await this.assertVisible(tx, ctx, [target]);
      await tx.assetRelationship.update({
        where: { id },
        data: { verification: 'rejected', verifiedByUserId: this.userId(ctx) },
      });
      await tx.relationshipEvidence.create({
        data: {
          organizationId: ctx.organizationId,
          relationshipId: id,
          kind: 'manual',
          detail: { action: 'corrected' },
        },
      });
      const edge = await this.upsertManualEdge(tx, ctx, r.sourceAssetId, target, type, {
        action: 'correction',
        replaces: id,
      });
      await this.audit.record(tx, ctx, {
        action: 'relationship.corrected',
        targetType: 'relationship',
        targetId: edge.id,
        metadata: {
          replaces: id,
          from: { type: r.relationshipType, target: r.targetAssetId },
          to: { type, target },
        },
      });
      return this.relationshipView(
        await tx.assetRelationship.findUniqueOrThrow({
          where: { id: edge.id },
          include: relationshipInclude,
        }),
      );
    });
  }

  createAsset(
    ctx: TenantContext,
    productId: string,
    input: { assetType: string; name: string; attributes?: Record<string, unknown> },
  ) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const id = randomUUID();
      await tx.asset.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          assetType: input.assetType as never,
          name: input.name,
          lifecycle: 'manually_managed',
          source: 'manual',
          identityKey: `manual:${id}`,
          attributes: (input.attributes ?? {}) as Prisma.InputJsonValue,
        },
      });
      await tx.productAsset.create({ data: { organizationId: ctx.organizationId, productId, assetId: id } });
      const a = await tx.asset.findUniqueOrThrow({
        where: { id },
        include: { products: { select: { productId: true } } },
      });
      await this.audit.record(tx, ctx, {
        action: 'asset.created',
        targetType: 'asset',
        targetId: id,
        metadata: { assetType: input.assetType, name: input.name, productId },
      });
      return this.assetView(a, ctx);
    });
  }

  retire(ctx: TenantContext, id: string) {
    return withTenant(this.prisma, ctx, async (tx) => {
      await this.assertVisible(tx, ctx, [id]);
      const a = await tx.asset.update({
        where: { id },
        data: { lifecycle: 'retired', retiredAt: this.now() },
        include: { products: { select: { productId: true } } },
      });
      await this.audit.record(tx, ctx, {
        action: 'asset.retired',
        targetType: 'asset',
        targetId: id,
        metadata: { name: a.name },
      });
      return this.assetView(a, ctx);
    });
  }

  /**
   * Alias candidates (UC-10-02): merge keeps the older asset and folds the newer one into
   * it (edges, product links, observations); the merged asset is retired with `mergedInto`
   * so later observations of its identity reach the kept asset.
   */
  resolveAlias(ctx: TenantContext, aliasId: string, action: 'merge' | 'keep_separate') {
    return withTenant(this.prisma, ctx, async (tx) => {
      const alias = await tx.assetAlias.findUnique({ where: { id: aliasId } });
      if (!alias || alias.status !== 'open') throw notFound();
      await this.assertVisible(tx, ctx, [alias.assetId, alias.candidateAssetId]);
      if (action === 'keep_separate') {
        await tx.assetAlias.update({
          where: { id: aliasId },
          data: { status: 'kept_separate', resolvedByUserId: this.userId(ctx) },
        });
      } else {
        const [keep, drop] = [alias.candidateAssetId, alias.assetId];
        const edges = await tx.assetRelationship.findMany({
          where: { OR: [{ sourceAssetId: drop }, { targetAssetId: drop }] },
        });
        for (const e of edges) {
          const source = e.sourceAssetId === drop ? keep : e.sourceAssetId;
          const target = e.targetAssetId === drop ? keep : e.targetAssetId;
          const clash =
            source === target
              ? null
              : await tx.assetRelationship.findUnique({
                  where: {
                    sourceAssetId_targetAssetId_relationshipType: {
                      sourceAssetId: source,
                      targetAssetId: target,
                      relationshipType: e.relationshipType,
                    },
                  },
                });
          if (source === target || clash) {
            // The kept asset already has this edge (or it would loop): keep its evidence there.
            if (clash)
              await tx.relationshipEvidence.updateMany({
                where: { relationshipId: e.id },
                data: { relationshipId: clash.id },
              });
            await tx.assetRelationship.delete({ where: { id: e.id } });
          } else {
            await tx.assetRelationship.update({
              where: { id: e.id },
              data: { sourceAssetId: source, targetAssetId: target },
            });
          }
        }
        const links = await tx.productAsset.findMany({ where: { assetId: drop } });
        for (const l of links)
          await tx.productAsset.upsert({
            where: { productId_assetId: { productId: l.productId, assetId: keep } },
            create: {
              organizationId: ctx.organizationId,
              productId: l.productId,
              assetId: keep,
              environmentId: l.environmentId,
            },
            update: {},
          });
        await tx.productAsset.deleteMany({ where: { assetId: drop } });
        await tx.assetObservation.updateMany({ where: { assetId: drop }, data: { assetId: keep } });
        const dropped = await tx.asset.findUniqueOrThrow({ where: { id: drop } });
        await tx.asset.update({
          where: { id: drop },
          data: {
            lifecycle: 'retired',
            retiredAt: this.now(),
            attributes: {
              ...((dropped.attributes ?? {}) as Record<string, unknown>),
              mergedInto: keep,
            } as Prisma.InputJsonValue,
          },
        });
        await tx.assetAlias.updateMany({
          where: { status: 'open', OR: [{ assetId: drop }, { candidateAssetId: drop }] },
          data: { status: 'merged', resolvedByUserId: this.userId(ctx) },
        });
      }
      await this.audit.record(tx, ctx, {
        action: action === 'merge' ? 'asset_alias.merged' : 'asset_alias.kept_separate',
        targetType: 'asset_alias',
        targetId: aliasId,
        metadata: { asset: alias.assetId, candidate: alias.candidateAssetId },
      });
      return { status: action === 'merge' ? 'merged' : 'kept_separate' };
    });
  }
}
