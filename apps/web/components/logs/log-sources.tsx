'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { LogSource } from './log-viewer';

export interface AgentUpgrade {
  agentVersion: string;
  minimumAgentVersion: string;
  /** Re-runs the installer without a token: upgrades in place, keeps the enrollment. */
  command: string;
}

/**
 * One button per source the agent allows; nothing for members without `logs.tail`. An agent
 * too old to tail gets the upgrade command instead of buttons that would fail.
 */
export function LogSources({
  sources,
  canTail,
  onOpen,
  upgrade,
}: {
  sources: LogSource[];
  canTail: boolean;
  onOpen: (source: LogSource) => void;
  upgrade?: AgentUpgrade;
}) {
  const [copied, setCopied] = useState(false);
  if (!canTail) return null;
  if (upgrade)
    return (
      <Alert tone="info" className="space-y-2">
        <p>
          Live logs need agent {upgrade.minimumAgentVersion} or later; this server runs {upgrade.agentVersion}
          . Run this on the server as root to upgrade it in place (it stays enrolled):
        </p>
        <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-3 font-mono text-xs">
          {upgrade.command}
        </pre>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(upgrade.command);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy command'}
        </Button>
      </Alert>
    );
  if (sources.length === 0)
    return <p className="text-sm text-muted-foreground">No log sources on this agent.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {sources.map((s) => (
        <Button key={s.id} size="sm" variant="outline" onClick={() => onOpen(s)}>
          {s.label}
        </Button>
      ))}
    </div>
  );
}
