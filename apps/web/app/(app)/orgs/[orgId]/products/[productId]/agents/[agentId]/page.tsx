'use client';

import { PageHeading } from '@/components/shell/page-heading';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { AgentStatusBadge } from '@/components/agents/agent-status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { relativeTime } from '@/lib/relative-time';
import { useApiQuery } from '@/lib/use-api-query';

export default function AgentDetailPage() {
  const { orgId, productId, agentId } = useParams<{ orgId: string; productId: string; agentId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const [error, setError] = useState<string | null>(null);
  const agent = useApiQuery(
    ['agent', agentId],
    async () => unwrap(await api.GET('/api/v1/agents/{id}', { params: { path: { id: agentId } } })),
    { refetchInterval: 10000 },
  );
  const tasks = useApiQuery(
    ['agent-tasks', agentId],
    async () => unwrap(await api.GET('/api/v1/agents/{id}/tasks', { params: { path: { id: agentId } } })),
    { refetchInterval: 3000 },
  );
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['agent', agentId] }),
      queryClient.invalidateQueries({ queryKey: ['agent-tasks', agentId] }),
      queryClient.invalidateQueries({ queryKey: ['agents', productId] }),
    ]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const a = agent.data;

  return (
    <QueryState query={agent} label="Loading agent">
      {a ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <Link
                href={`/orgs/${orgId}/products/${productId}/agents`}
                className="text-sm text-muted-foreground hover:underline"
              >
                ← Agents
              </Link>
              <PageHeading
                title={
                  <>
                    {a.hostname} <AgentStatusBadge status={a.status} stale={a.stale} />
                  </>
                }
                eyebrow="Product operations"
              />
              <p className="text-sm text-muted-foreground">
                {a.environmentName} · {a.os} · {a.arch} · agent {a.agentVersion} · last seen{' '}
                {relativeTime(a.lastHeartbeatAt)} ·{' '}
                <Link
                  href={`/orgs/${orgId}/products/${productId}/infrastructure/${agentId}`}
                  className="underline"
                >
                  metrics
                </Link>
              </p>
            </div>
            {a.status !== 'revoked' ? (
              <div className="flex gap-2">
                {roleCan(role, 'agent.enroll') ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      act(async () =>
                        unwrap(
                          await api.POST('/api/v1/agents/{id}/diagnostics', {
                            params: { path: { id: agentId } },
                          }),
                        ),
                      )
                    }
                  >
                    Run diagnostics
                  </Button>
                ) : null}
                {roleCan(role, 'agent.revoke') ? (
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="destructive">Revoke</Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogTitle>Revoke {a.hostname}?</DialogTitle>
                      <DialogDescription>
                        The agent is disconnected immediately and its certificates stop working. To monitor
                        this server again, enroll it with a new install command.
                      </DialogDescription>
                      <div className="flex justify-end gap-2">
                        <DialogClose asChild>
                          <Button variant="ghost">Cancel</Button>
                        </DialogClose>
                        <DialogClose asChild>
                          <Button
                            variant="destructive"
                            onClick={() =>
                              act(async () =>
                                unwrap(
                                  await api.POST('/api/v1/agents/{id}/revoke', {
                                    params: { path: { id: agentId } },
                                  }),
                                ),
                              )
                            }
                          >
                            Revoke agent
                          </Button>
                        </DialogClose>
                      </div>
                    </DialogContent>
                  </Dialog>
                ) : null}
              </div>
            ) : null}
          </div>
          {error ? <Alert>{error}</Alert> : null}
          {a.clockSkewSeconds ? (
            <Alert tone="info">
              This server&apos;s clock is off by {Math.abs(a.clockSkewSeconds)} s. Enable NTP so certificates
              and timestamps stay valid.
            </Alert>
          ) : null}
          {a.duplicateMachineId ? (
            <Alert tone="info">Another server reports the same machine ID (cloned image?).</Alert>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="space-y-2">
              <CardTitle className="text-base">Identity</CardTitle>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Agent ID</dt>
                <dd className="break-all font-mono text-xs">{a.id}</dd>
                <dt className="text-muted-foreground">Certificate expires</dt>
                <dd>{a.certificate ? new Date(a.certificate.notAfter).toLocaleString() : '—'}</dd>
                <dt className="text-muted-foreground">Policy version</dt>
                <dd>{a.policyVersion}</dd>
                <dt className="text-muted-foreground">Capabilities</dt>
                <dd className="flex flex-wrap gap-1">
                  {a.capabilities.length ? a.capabilities.map((c) => <Badge key={c}>{c}</Badge>) : '—'}
                </dd>
              </dl>
            </Card>
            <Card className="space-y-2">
              <CardTitle className="text-base">Recent heartbeats</CardTitle>
              {a.recentHeartbeats.length ? (
                <ul className="space-y-1 text-sm">
                  {a.recentHeartbeats.slice(0, 8).map((h) => (
                    <li key={h.receivedAt} className="flex justify-between text-muted-foreground">
                      <span>{relativeTime(h.receivedAt)}</span>
                      <span>
                        {h.health} · queue {h.queueDepth}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No heartbeat yet.</p>
              )}
            </Card>
          </div>
          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Tasks</h2>
            <QueryState query={tasks} label="Loading tasks">
              {tasks.data?.tasks.length ? (
                <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                  {tasks.data.tasks.map((t) => (
                    <li key={t.id} className="space-y-1 px-4 py-3 text-sm">
                      <div className="flex justify-between">
                        <span className="font-medium">
                          {t.type} {String((t.payload as { target?: string }).target ?? '')}
                        </span>
                        <Badge>{t.status}</Badge>
                      </div>
                      {t.result ? (
                        <pre className="overflow-auto rounded bg-muted p-2 font-mono text-xs">
                          {JSON.stringify(t.result, null, 2)}
                        </pre>
                      ) : null}
                      {t.error ? <p className="text-destructive">{t.error}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No tasks yet.</p>
              )}
            </QueryState>
          </section>
        </div>
      ) : null}
    </QueryState>
  );
}
