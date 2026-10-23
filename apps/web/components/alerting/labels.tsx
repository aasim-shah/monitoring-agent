import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

export type Severity = 'critical' | 'warning' | 'info';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

const SEVERITY: Record<Severity, { label: string; className: string }> = {
  critical: { label: 'Critical', className: 'border-destructive/40 text-destructive' },
  warning: { label: 'Warning', className: 'border-warning/40 text-warning' },
  info: { label: 'Info', className: '' },
};

const STATUS: Record<IncidentStatus, { label: string; className: string }> = {
  open: { label: 'Open', className: 'border-destructive/40 text-destructive' },
  acknowledged: { label: 'Acknowledged', className: 'border-warning/40 text-warning' },
  resolved: { label: 'Resolved', className: 'border-success/40 text-success' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return <Badge className={cn(s.className)}>{s.label}</Badge>;
}

export function StatusBadge({ status }: { status: IncidentStatus }) {
  const s = STATUS[status];
  return <Badge className={cn(s.className)}>{s.label}</Badge>;
}

/** "45 s", "30 min", "3 h 5 min", "2 d 4 h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export const when = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
