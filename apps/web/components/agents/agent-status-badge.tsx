import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

const LABEL = { active: 'Active', degraded: 'Degraded', revoked: 'Revoked' } as const;
const TONE = {
  active: 'border-success/40 text-success',
  degraded: 'border-amber-500/40 text-amber-600',
  revoked: 'text-muted-foreground',
} as const;

/** Degraded: no heartbeat for 90 s. Stale: none for 5 min (spec §8.2). */
export function AgentStatusBadge({ status, stale }: { status: keyof typeof LABEL; stale: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge className={cn(TONE[status])}>{LABEL[status]}</Badge>
      {stale && status !== 'revoked' ? (
        <Badge title="No heartbeat for over 5 minutes" className="border-destructive/40 text-destructive">
          Stale
        </Badge>
      ) : null}
    </span>
  );
}
