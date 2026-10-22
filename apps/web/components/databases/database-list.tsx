'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { formatValue } from '@/lib/format';

export interface DatabaseRow {
  id: string;
  displayName: string;
  provider: string;
  status: string;
  statusReason: string | null;
  /** `data` of the latest health check, or null. */
  health: Record<string, unknown> | null;
}

const ENGINE: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB' };

const REASONS: Record<string, string> = {
  authentication_failed: 'Authentication failed (check the secret file)',
  network_unreachable: 'The worker cannot reach the database',
  tls_unavailable: 'The database does not offer TLS',
  invalid_config: 'Configuration error',
  provider_unavailable: 'Database error',
};

function statusOf(r: DatabaseRow): { label: string; tone: string; note?: string } {
  if (r.status === 'connected') return { label: 'Connected', tone: 'border-success/40 text-success' };
  if (['draft', 'pending_auth', 'pending_validation'].includes(r.status))
    return { label: 'Validating…', tone: 'animate-pulse' };
  if (r.statusReason === 'worker_offline')
    return {
      label: 'Worker offline',
      tone: 'border-amber-500/40 text-amber-600',
      note: 'No data until the private worker reconnects.',
    };
  if (r.statusReason === 'permission_denied')
    return {
      label: 'Permission denied',
      tone: 'border-destructive/40 text-destructive',
      note: 'The database user can write. Use a read-only user, or allow it anyway (recorded in the audit log).',
    };
  if (r.status === 'disconnected') return { label: 'Disconnected', tone: '' };
  return {
    label: 'Failed',
    tone: 'border-destructive/40 text-destructive',
    note: REASONS[r.statusReason ?? ''] ?? r.statusReason ?? undefined,
  };
}

/** Total size across what the engine reports (databases, schemas, or one database). */
function sizeOf(h: Record<string, unknown>): number | null {
  const list = (h.databases ?? h.schemas) as Array<{ bytes: number }> | undefined;
  if (Array.isArray(list)) return list.reduce((n, d) => n + (d.bytes ?? 0), 0);
  const db = h.database as { dataSizeBytes?: number; indexSizeBytes?: number } | undefined;
  return db?.dataSizeBytes !== undefined ? db.dataSizeBytes + (db.indexSizeBytes ?? 0) : null;
}

function slowOf(h: Record<string, unknown>): string {
  const s = h.slowQueries;
  if (typeof s === 'string') return s;
  if (typeof s === 'number') return `${s} slow`;
  if (Array.isArray(s)) return `${s.length} top queries`;
  return '—';
}

export function DatabaseList({
  rows,
  canConfigure,
  onOverride,
}: {
  rows: DatabaseRow[];
  canConfigure: boolean;
  onOverride: (id: string) => Promise<void>;
}) {
  if (rows.length === 0)
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        No databases yet. Add one to see connections, size, and replication health.
      </p>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Database</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Connections</th>
            <th className="px-4 py-2 font-medium">Size</th>
            <th className="px-4 py-2 font-medium">Replication lag</th>
            <th className="px-4 py-2 font-medium">Slow queries</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const s = statusOf(r);
            const h = r.statusReason === 'worker_offline' ? null : r.health;
            const size = h ? sizeOf(h) : null;
            const lag = h?.replicationLagSeconds;
            return (
              <tr key={r.id} aria-label={r.displayName}>
                <td className="px-4 py-2 align-top">
                  <div className="font-medium">{r.displayName}</div>
                  <div className="text-xs text-muted-foreground">{ENGINE[r.provider] ?? r.provider}</div>
                </td>
                <td className="px-4 py-2 align-top">
                  <Badge className={cn(s.tone)}>{s.label}</Badge>
                  {s.note ? <p className="mt-1 max-w-xs text-xs text-muted-foreground">{s.note}</p> : null}
                  {r.statusReason === 'permission_denied' && canConfigure ? (
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => onOverride(r.id)}>
                      Allow anyway
                    </Button>
                  ) : null}
                </td>
                <td className="px-4 py-2 align-top tabular-nums">
                  {h && typeof h.connections === 'number'
                    ? `${h.connections}${typeof h.maxConnections === 'number' ? ` / ${h.maxConnections}` : ''}`
                    : '—'}
                </td>
                <td className="px-4 py-2 align-top tabular-nums">
                  {size !== null ? formatValue(size, 'bytes') : '—'}
                </td>
                <td className="px-4 py-2 align-top tabular-nums">
                  {typeof lag === 'number' ? `${lag.toFixed(1)} s` : '—'}
                </td>
                <td className="px-4 py-2 align-top text-xs">{h ? slowOf(h) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
