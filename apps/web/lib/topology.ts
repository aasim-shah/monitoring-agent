import type { Edge, Node } from '@xyflow/react';

export interface TopologyNode {
  id: string;
  name: string;
  assetType: string;
  lifecycle: string;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  verification: string;
  confidence: number;
}

/** Layers read top to bottom the way traffic flows: entry points, machines, what runs on them, the rest. */
const TIER: Record<string, number> = {
  website: 0,
  domain: 0,
  host: 1,
  worker: 1,
  service: 2,
  database: 2,
  repository: 3,
  external: 3,
};

const X_GAP = 220;
const Y_GAP = 140;

const EDGE_STYLE: Record<string, { stroke: string; strokeDasharray?: string }> = {
  verified: { stroke: 'var(--color-slate-500)' },
  proposed: { stroke: 'var(--color-slate-400)', strokeDasharray: '6 4' },
  drifted: { stroke: 'var(--color-amber-600)', strokeDasharray: '2 3' },
};

/** React Flow nodes and edges with a layered layout; solid = verified, dashed = proposed, amber = drifted. */
export function toFlow(nodes: TopologyNode[], edges: TopologyEdge[]): { nodes: Node[]; edges: Edge[] } {
  const byTier = new Map<number, TopologyNode[]>();
  for (const n of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    const t = TIER[n.assetType] ?? 3;
    byTier.set(t, [...(byTier.get(t) ?? []), n]);
  }
  const widest = Math.max(1, ...[...byTier.values()].map((l) => l.length));
  const out: Node[] = [];
  for (const [tier, list] of byTier) {
    const offset = ((widest - list.length) * X_GAP) / 2;
    list.forEach((n, i) =>
      out.push({
        id: n.id,
        position: { x: offset + i * X_GAP, y: tier * Y_GAP },
        data: {
          label: `${n.name}\n${n.assetType}${n.lifecycle === 'active' || n.lifecycle === 'discovered' ? '' : ` · ${n.lifecycle}`}`,
        },
        className: `topology-node topology-${n.assetType} ${n.lifecycle === 'missing' ? 'opacity-60' : ''}`,
      }),
    );
  }
  const ids = new Set(nodes.map((n) => n.id));
  return {
    nodes: out,
    edges: edges
      .filter((e) => e.verification !== 'rejected' && ids.has(e.source) && ids.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: `${e.type} · ${Math.round(e.confidence * 100)}%`,
        style: EDGE_STYLE[e.verification] ?? EDGE_STYLE.proposed,
        animated: false,
        data: { verification: e.verification },
      })),
  };
}
