import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

export interface ImpactRow {
  assetId: string;
  name: string;
  assetType: string;
  distance: number;
  impact: 'confirmed' | 'potential' | 'unknown';
  via: string[];
}

const CLASS = {
  confirmed: { label: 'Confirmed', tone: 'border-destructive/40 text-destructive' },
  potential: { label: 'Potential', tone: 'border-amber-500/40 text-amber-600' },
  unknown: { label: 'Unknown', tone: '' },
} as const;

/** Blast radius (UC-10-10): a dependency alone does not prove an outage (BR-10-07). */
export function ImpactList({ impact }: { impact: ImpactRow[] }) {
  if (impact.length === 0)
    return (
      <p className="text-sm text-muted-foreground">Nothing depends on this asset in the graph you can see.</p>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Dependent</th>
            <th className="px-4 py-2 font-medium">Impact</th>
            <th className="px-4 py-2 font-medium">Hops</th>
            <th className="px-4 py-2 font-medium">Path</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {impact.map((i) => (
            <tr key={i.assetId} aria-label={i.name}>
              <td className="px-4 py-2">
                <div className="font-medium">{i.name}</div>
                <div className="text-xs text-muted-foreground">{i.assetType}</div>
              </td>
              <td className="px-4 py-2">
                <Badge className={cn(CLASS[i.impact].tone)}>{CLASS[i.impact].label}</Badge>
              </td>
              <td className="px-4 py-2 tabular-nums">{i.distance}</td>
              <td className="px-4 py-2 text-xs text-muted-foreground">{i.via.join(' → ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
