'use client';

import '@xyflow/react/dist/style.css';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { useMemo } from 'react';
import { toFlow, type TopologyEdge, type TopologyNode } from '@/lib/topology';

/** Product topology (UC-10-09): solid = verified, dashed = proposed, amber = drifted. */
export function TopologyGraph({
  nodes,
  edges,
  onNodeClick,
}: {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  onNodeClick?: (id: string) => void;
}) {
  const flow = useMemo(() => toFlow(nodes, edges), [nodes, edges]);
  if (nodes.length === 0)
    return <p className="text-sm text-muted-foreground">No assets yet. Run discovery to build the graph.</p>;
  return (
    <div className="h-[560px] rounded-lg border border-border bg-card">
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        fitView
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => onNodeClick?.(n.id)}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="flex gap-4 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span>— verified</span>
        <span>- - proposed</span>
        <span className="text-amber-600">··· drifted</span>
      </div>
    </div>
  );
}
