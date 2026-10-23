'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Ref {
  id: string;
  name: string;
  assetType: string;
}

export interface ReviewEdge {
  id: string;
  type: string;
  verification: string;
  confidence: number;
  ruleId: string | null;
  source: Ref;
  target: Ref;
  evidence: Array<{ kind: string; detail: Record<string, unknown>; observedAt: string }>;
  updatedAt: string;
}

export interface ReviewAlias {
  id: string;
  reason: string;
  asset: Ref;
  candidate: Ref;
  createdAt: string;
}

const evidenceText = (e: ReviewEdge['evidence'][number]) => {
  const d = e.detail ?? {};
  const facts = ['ip', 'domain', 'pack', 'connectionHost', 'reason']
    .filter((k) => d[k] !== undefined)
    .map((k) => `${k} ${String(d[k])}`);
  return `${e.kind}${facts.length ? `: ${facts.join(', ')}` : ''}`;
};

/** Discovery review (UC-10-04): confirm or reject proposed and drifted edges; merge or keep alias candidates. */
export function ReviewQueue({
  edges,
  aliases,
  canVerify,
  canManage,
  onVerify,
  onReject,
  onResolve,
}: {
  edges: ReviewEdge[];
  aliases: ReviewAlias[];
  canVerify: boolean;
  canManage: boolean;
  onVerify: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onResolve: (id: string, action: 'merge' | 'keep_separate') => Promise<void>;
}) {
  if (edges.length === 0 && aliases.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nothing to review: every relationship is confirmed or rejected.
      </p>
    );
  return (
    <div className="space-y-6">
      {edges.length ? (
        <ul className="space-y-2">
          {edges.map((e) => (
            <li key={e.id} className="rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {e.source.name} → {e.target.name}
                    <Badge>{e.type}</Badge>
                    <Badge
                      className={e.verification === 'drifted' ? 'border-amber-500/40 text-amber-600' : ''}
                    >
                      {e.verification === 'drifted' ? 'Drifted' : 'Proposed'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {Math.round(e.confidence * 100)}% confidence{e.ruleId ? ` · rule ${e.ruleId}` : ''}
                    {e.evidence[0] ? ` · ${evidenceText(e.evidence[0])}` : ''}
                  </p>
                </div>
                {canVerify ? (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => onVerify(e.id)}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onReject(e.id)}>
                      Reject
                    </Button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {aliases.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Possible duplicates</h3>
          <ul className="space-y-2">
            {aliases.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-sm"
              >
                <span>
                  {a.asset.name} ({a.asset.assetType}) and {a.candidate.name}: {a.reason}
                </span>
                {canManage ? (
                  <span className="flex gap-2">
                    <Button size="sm" onClick={() => onResolve(a.id, 'merge')}>
                      Merge
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onResolve(a.id, 'keep_separate')}>
                      Keep separate
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
