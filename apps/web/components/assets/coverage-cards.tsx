import { Card, CardTitle } from '@/components/ui/card';

export interface Coverage {
  assets: number;
  byLifecycle: Record<string, number>;
  byType: Record<string, number>;
  edges: Record<string, number>;
  stale: number;
}

/** Coverage report (UC-10-11). */
export function CoverageCards({ coverage }: { coverage: Coverage }) {
  const cards: Array<[string, number, string?]> = [
    ['Assets', coverage.assets],
    ['Verified relationships', coverage.edges.verified ?? 0],
    ['To review', (coverage.edges.proposed ?? 0) + (coverage.edges.drifted ?? 0)],
    ['Missing', coverage.byLifecycle.missing ?? 0, 'Not seen in 3 discovery runs'],
    ['Stale', coverage.stale, 'Not seen for 24 hours'],
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(([label, n, hint]) => (
          <Card key={label} className="p-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{n}</p>
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          </Card>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        By type:{' '}
        {Object.entries(coverage.byType)
          .map(([t, n]) => `${n} ${t}`)
          .join(' · ') || 'none'}
      </p>
    </div>
  );
}
