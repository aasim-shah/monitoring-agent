'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { EnablePackDialog, type EnablePackBody } from './enable-pack-dialog';

export interface CatalogPack {
  id: string;
  name: string;
  description: string;
  defaultEndpoint: string | null;
  credentialFields: Array<{ name: string; label: string; secret: boolean; required: boolean }>;
  /** Level 2 guided setup, for packs that have one (M10.5). */
  guide?: import('./guided-setup').Guide;
}

export interface DetectedService {
  pack: string;
  name: string;
  ports: Array<{ address: string; port: number }>;
  processCount: number;
}

export interface Assignment {
  packId: string;
  status: 'pending' | 'applied' | 'failed' | 'removing';
  statusMessage: string | null;
  inspection?: { enabled: boolean; redisKeys: string[]; peekTopics: string[] };
}

const hostPort = (a: string, p: number) => (a.includes(':') ? `[${a}]:${p}` : `${a}:${p}`);

const STATUS: Record<Assignment['status'] | 'none', { label: string; className: string }> = {
  none: { label: 'Not monitored', className: '' },
  pending: { label: 'Applying…', className: 'animate-pulse' },
  applied: { label: 'Monitoring', className: 'border-success/40 text-success' },
  failed: { label: 'Failed', className: 'border-destructive/40 text-destructive' },
  removing: { label: 'Stopping…', className: 'animate-pulse' },
};

const selectClass = 'h-9 rounded-md border border-border bg-background px-2 text-sm';

/**
 * "Services on this server" (WB-11): what discovery found, databases exposed beyond
 * loopback, and monitoring status. Nothing is collected until someone enables a pack.
 */
export function ServicesPanel({
  catalog,
  services,
  warnings,
  assignments,
  canManage,
  seal,
  onEnable,
  onDisable,
}: {
  catalog: CatalogPack[];
  services: DetectedService[];
  warnings: Array<{ pack: string; address: string; port: number }>;
  assignments: Assignment[];
  canManage: boolean;
  seal: (fields: Record<string, string>) => Promise<string>;
  onEnable: (body: EnablePackBody) => Promise<void>;
  onDisable: (packId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const byPack = new Map(assignments.map((a) => [a.packId, a]));
  const detected = new Map(services.map((s) => [s.pack, s]));
  const rows = catalog.filter((p) => detected.has(p.id) || byPack.has(p.id));
  const others = catalog.filter((p) => !rows.includes(p));
  const editingPack = catalog.find((p) => p.id === editing);

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          No supported services detected yet. The agent looks for Redis, PostgreSQL, MySQL, MongoDB, Kafka,
          nginx, and Node.js every 5 minutes.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Service</th>
                <th className="px-4 py-2 font-medium">Listening on</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((p) => {
                const svc = detected.get(p.id);
                const a = byPack.get(p.id);
                const status = STATUS[a?.status ?? 'none'];
                const exposed = warnings.filter((w) => w.pack === p.id);
                return (
                  <tr key={p.id} aria-label={p.name}>
                    <td className="px-4 py-2 align-top">
                      <div className="font-medium">{p.name}</div>
                      {svc ? (
                        <div className="text-xs text-muted-foreground">
                          {svc.processCount} process{svc.processCount === 1 ? '' : 'es'}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">Not detected right now</div>
                      )}
                    </td>
                    <td className="px-4 py-2 align-top">
                      {svc?.ports.length ? (
                        <ul className="space-y-0.5 font-mono text-xs">
                          {svc.ports.map((port) => (
                            <li key={hostPort(port.address, port.port)}>
                              {hostPort(port.address, port.port)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                      {exposed.map((w) => (
                        <p
                          key={hostPort(w.address, w.port)}
                          className="mt-1 text-xs font-medium text-destructive"
                        >
                          Exposed to the internet on {hostPort(w.address, w.port)}. Bind it to 127.0.0.1 or
                          firewall the port.
                        </p>
                      ))}
                    </td>
                    <td className="px-4 py-2 align-top">
                      <Badge className={cn(status.className)}>{status.label}</Badge>
                      {a?.status === 'failed' && a.statusMessage ? (
                        <p className="mt-1 max-w-xs break-words text-xs text-destructive">
                          {a.statusMessage}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-right align-top">
                      {canManage && a?.status !== 'removing' ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant={a ? 'outline' : 'default'}
                            onClick={() => setEditing(p.id)}
                          >
                            {a ? 'Change' : 'Monitor'}
                          </Button>
                          {a ? (
                            <Button size="sm" variant="ghost" onClick={() => onDisable(p.id)}>
                              Stop monitoring
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canManage && others.length ? (
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="other-pack" className="text-muted-foreground">
            Monitor another service
          </label>
          <select
            id="other-pack"
            className={selectClass}
            value=""
            onChange={(e) => e.target.value && setEditing(e.target.value)}
          >
            <option value="">Choose…</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {editingPack ? (
        <EnablePackDialog
          key={editingPack.id}
          pack={editingPack}
          updating={byPack.has(editingPack.id)}
          onClose={() => setEditing(null)}
          seal={seal}
          onSubmit={onEnable}
        />
      ) : null}
    </div>
  );
}
