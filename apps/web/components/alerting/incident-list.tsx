'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SeverityBadge, StatusBadge, duration, type IncidentStatus, type Severity } from './labels';

export type IncidentFilter = 'active' | 'open' | 'acknowledged' | 'resolved' | 'all';

export interface IncidentRow {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  startedAt: string;
  resolvedAt: string | null;
}

const FILTERS: Array<{ id: IncidentFilter; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

/** Incident list (WB-13 §8): severity, status, title, start, and how long it lasted. */
export function IncidentList({
  incidents,
  filter,
  onFilter,
  hrefFor,
  now = new Date(),
}: {
  incidents: IncidentRow[];
  filter: IncidentFilter;
  onFilter: (f: IncidentFilter) => void;
  hrefFor: (id: string) => string;
  now?: Date;
}) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="group" aria-label="Filter incidents">
        {FILTERS.map((f) => (
          <Button
            key={f.id}
            size="sm"
            variant={filter === f.id ? 'default' : 'outline'}
            aria-pressed={filter === f.id}
            onClick={() => onFilter(f.id)}
          >
            {f.label}
          </Button>
        ))}
      </div>
      {incidents.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          {filter === 'active'
            ? 'No active incidents. Incidents open when an alert rule fires on real data.'
            : 'No incidents match this filter.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Severity</th>
                <th className="px-4 py-2 font-medium">Incident</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {incidents.map((i) => {
                const end = i.resolvedAt ? new Date(i.resolvedAt) : now;
                return (
                  <tr key={i.id} aria-label={i.title}>
                    <td className="px-4 py-2">
                      <SeverityBadge severity={i.severity} />
                    </td>
                    <td className="px-4 py-2 font-medium">
                      <Link className="hover:underline" href={hrefFor(i.id)}>
                        {i.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={i.status} />
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {new Date(i.startedAt).toLocaleString('en-GB', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {duration(end.getTime() - new Date(i.startedAt).getTime())}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
