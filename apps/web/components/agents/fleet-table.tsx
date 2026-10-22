import Link from 'next/link';
import { relativeTime } from '@/lib/relative-time';
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

export function FleetTable({
  agents,
  basePath,
  now,
}: {
  agents: FleetAgent[];
  basePath: string;
  now?: Date;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Server</th>
            <th className="px-4 py-2 font-medium">Environment</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Agent</th>
            <th className="px-4 py-2 font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {agents.map((a) => (
            <tr key={a.id}>
              <td className="px-4 py-2">
                <Link href={`${basePath}/${a.id}`} className="font-medium underline-offset-2 hover:underline">
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
                <div className="text-xs text-muted-foreground">
                  {a.os} · {a.arch}
                </div>
              </td>
              <td className="px-4 py-2">{a.environmentName}</td>
              <td className="px-4 py-2">
                <AgentStatusBadge status={a.status} stale={a.stale} />
              </td>
              <td className="px-4 py-2 text-muted-foreground">{a.agentVersion}</td>
              <td className="px-4 py-2 text-muted-foreground">{relativeTime(a.lastHeartbeatAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
