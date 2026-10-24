'use client';

import { useCallback, useState } from 'react';
import { unwrap } from '@pcp/api-client';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { openEventStream } from '@/lib/sse';
import { useApiQuery } from '@/lib/use-api-query';
import { LogSources } from './log-sources';
import { LogSearch } from './log-search';
import { LogViewer, type Connect, type LogSource } from './log-viewer';

/** "Logs" on a server page: the applied packs' sources plus the system journal, one tail at a time. */
export function LogsSection({
  agentId,
  productId,
  canTail,
}: {
  agentId: string;
  /** Retained-log search runs per product, filtered to this host (M18.1). */
  productId?: string;
  canTail: boolean;
}) {
  const [open, setOpen] = useState<LogSource | null>(null);
  const sources = useApiQuery(
    ['log-sources', agentId],
    async () =>
      unwrap(await api.GET('/api/v1/agents/{id}/log-sources', { params: { path: { id: agentId } } })),
    { enabled: canTail, refetchInterval: 60_000 },
  );
  const connect = useCallback<Connect>(
    (handlers) =>
      open
        ? openEventStream(
            `/api/v1/agents/${encodeURIComponent(agentId)}/logs/tail?source=${encodeURIComponent(open.id)}`,
            handlers,
          )
        : () => {},
    [agentId, open],
  );
  if (!canTail) return null;
  return (
    <section className="space-y-3" aria-labelledby="logs-heading">
      <h2 id="logs-heading" className="text-lg font-semibold">
        Logs
      </h2>
      <QueryState query={sources} label="Loading log sources">
        <LogSources
          sources={sources.data?.sources ?? []}
          canTail={canTail}
          onOpen={setOpen}
          upgrade={
            sources.data?.upgradeRequired && sources.data.upgradeCommand
              ? {
                  agentVersion: sources.data.agentVersion ?? 'unknown',
                  minimumAgentVersion: sources.data.minimumAgentVersion ?? '',
                  command: sources.data.upgradeCommand,
                }
              : undefined
          }
        />
      </QueryState>
      {open ? (
        <LogViewer key={open.id} source={open} connect={connect} onClose={() => setOpen(null)} />
      ) : null}
      {productId ? (
        <LogSearch
          search={async (query, range) =>
            unwrap(
              await api.GET('/api/v1/products/{productId}/logs/search', {
                params: { path: { productId }, query: { query, range, agentId } },
              }),
            )
          }
        />
      ) : null}
    </section>
  );
}
