'use client';

import { useState } from 'react';
import { relativeTime } from '@/lib/relative-time';
import Link from 'next/link';

import { AgentStatusBadge } from './agent-status-badge';

export interface FleetAgent {
  id: string;
  hostname: string;
  os: string;
  arch: string;
  agentVersion: string;
  environmentName: string;
  status: 'active' | 'degraded' | 'revoked';
  stale: boolean;
  lastHeartbeatAt: string | null;
  duplicateMachineId: boolean;
}

export function FleetTable({ agents, basePath, now }: { agents: FleetAgent[]; basePath: string; now?: Date }) {
  const [search, setSearch] = useState('');
  const visible = agents.filter((a) =>
    `${a.hostname} ${a.environmentName} ${a.status} ${a.agentVersion}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="portal-fleet-section">
      <label className="portal-row-filter">
        <span className="sr-only">Filter agents</span>
        <input
          type="search"
          placeholder="Filter visible rows…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Host</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Version</th>
              <th className="px-4 py-2 font-medium">Last heartbeat</th>
              <th className="px-4 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-2">
                  <Link
                    href={`${basePath}/${a.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {a.hostname}
                  </Link>
                  {a.duplicateMachineId ? (
                    <span
                      className="ml-2 text-amber-600"
                      title="Another server reports the same machine ID (cloned image?). Each agent still has its own identity."
                    >
                      ⚠
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2">
                  <AgentStatusBadge status={a.status} stale={a.stale} />
                </td>
                <td className="px-4 py-2 text-muted-foreground">{a.agentVersion}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  {a.lastHeartbeatAt ? (
                    <time dateTime={a.lastHeartbeatAt} title={relativeTime(a.lastHeartbeatAt, now)}>
                      {new Intl.DateTimeFormat('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                        hourCycle: 'h23',
                      }).format(new Date(a.lastHeartbeatAt))}
                    </time>
                  ) : (
                    'Not received'
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <Link className="portal-table-action" href={`${basePath}/${a.id}`}>
                    Inspect agent ↗
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && <p className="portal-no-results">No agents match this filter.</p>}
      </div>
    </div>
  );
}
