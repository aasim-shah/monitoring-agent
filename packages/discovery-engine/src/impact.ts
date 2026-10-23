import type { Prisma } from '@pcp/database';

type Tx = Prisma.TransactionClient;

/** Impact walks from an asset to what depends on it: these edges point dependent → dependency… */
const DEPENDS_TYPES = ['ROUTES_TO', 'DEPENDS_ON', 'CONNECTS_TO', 'DEPLOYED_ON'];
/** …and HOSTS points dependency → dependent. */
const HOSTS_TYPE = 'HOSTS';
/** An agent without a heartbeat for this long counts as failing (spec §8.2: degraded after 90 s). */
const AGENT_FAILING_AFTER_MS = 90_000;

export type ImpactClass = 'confirmed' | 'potential' | 'unknown';

export interface ImpactedAsset {
  assetId: string;
  name: string;
  assetType: string;
  distance: number;
  impact: ImpactClass;
  via: string[];
}

/**
 * Blast radius (UC-10-10): walks to dependents up to `depth` (1–6) through visible assets only
 * (`products` null = all), skipping rejected edges and cycles.
 * confirmed = the dependent's own health is failing; potential = reached through verified
 * or ≥ 0.8 edges; unknown = otherwise (BR-10-07: a dependency alone proves no outage).
 * Runs inside the caller's tenant transaction (RLS applies).
 */
export async function computeImpact(
  tx: Tx,
  assetId: string,
  opts: { products: string[] | null; depth: number; now: Date },
): Promise<ImpactedAsset[]> {
  const { products, depth } = opts;
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
  const failing = await failingAssets(tx, opts.now, rows.map((r) => byId.get(r.asset_id)!).filter(Boolean));
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
}

/** Dependents whose own health is failing: a database's latest check, or an agent that stopped reporting. */
async function failingAssets(tx: Tx, now: Date, assets: Array<{ id: string; attributes: Prisma.JsonValue }>) {
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
      if (
        agent &&
        (agent.status === 'revoked' ||
          now.getTime() - (agent.lastHeartbeatAt ?? agent.createdAt).getTime() > AGENT_FAILING_AFTER_MS)
      )
        failing.add(a.id);
    }
  }
  return failing;
}
