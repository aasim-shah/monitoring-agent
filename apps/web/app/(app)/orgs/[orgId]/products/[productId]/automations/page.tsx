'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { ActionList, type ActionRow } from '@/components/actions/action-list';
import { PolicyList, type PolicyInput, type PolicyRow } from '@/components/actions/policy-list';
import { ProposeDialog, type NewProposal } from '@/components/actions/propose-dialog';
import { Alert } from '@/components/ui/alert';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useMe, useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

export default function AutomationsPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const me = useMe();
  const role = (org.data?.role ?? 'viewer') as Role;
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const policies = useApiQuery(['action-policies', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{id}/action-policies', { params: { path: { id: productId } } })),
  );
  const actions = useApiQuery(
    ['actions', productId],
    async () =>
      unwrap(await api.GET('/api/v1/products/{id}/actions', { params: { path: { id: productId } } })),
    { refetchInterval: 5000 },
  );
  const agents = useApiQuery(['agents', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{productId}/agents', { params: { path: { productId } } })),
  );
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['action-policies', productId] }),
      queryClient.invalidateQueries({ queryKey: ['actions', productId] }),
    ]);
  const run = async (f: () => Promise<unknown>, done?: string) => {
    setMessage(null);
    try {
      await f();
      await refresh();
      if (done) setMessage({ tone: 'info', text: done });
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    }
  };

  const policyRows = (policies.data?.policies ?? []) as PolicyRow[];
  const production = new Map(policyRows.map((p) => [p.environmentId, p.production]));
  const unitsByEnvironment: Record<string, string[]> = {};
  for (const p of policyRows)
    if (p.capability === 'host.restart_service' && p.enabled)
      unitsByEnvironment[p.environmentId] = p.settings.units ?? [];
  const hosts = (agents.data?.agents ?? [])
    .filter((a) => a.agentType === 'host' && a.status !== 'revoked')
    .map((a) => ({ agentId: a.id, hostname: a.hostname, environmentId: a.environmentId }));

  const rows: ActionRow[] = (actions.data?.actions ?? []).map((a) => {
    const impact = (a.impact ?? {}) as { summary?: string; host?: string };
    return {
      id: a.id,
      capability: a.capability,
      params: a.params,
      host: impact.host ?? null,
      status: a.status,
      proposedByAi: a.proposedByAi,
      requestedByUserId: a.requestedByUserId ?? null,
      production: production.get(a.environmentId) ?? false,
      impactSummary: impact.summary ?? null,
      createdAt: a.createdAt,
    };
  });

  const propose = (p: NewProposal) =>
    run(async () => {
      const r = unwrap(
        await api.POST('/api/v1/actions/proposals', {
          body: {
            productId,
            environmentId: p.environmentId,
            capability: 'host.restart_service',
            target: { agentId: p.agentId },
            params: { unit: p.unit },
            idempotencyKey: crypto.randomUUID(),
            reason: p.reason,
          },
        }),
      );
      if (r.status === 'rejected_policy') throw new Error(r.reason ?? 'Not allowed by policy');
    }, 'Sent for approval.');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Automations & Approvals</h1>
          <p className="text-sm text-muted-foreground">
            Restart an allowlisted service after someone approves it. Every action is checked against its
            policy, shows its impact first, runs once through a signed short-lived task, is verified, and is
            audited. The AI assistant can only propose.
          </p>
        </div>
        {roleCan(role, 'action.propose') && hosts.length ? (
          <ProposeDialog hosts={hosts} unitsByEnvironment={unitsByEnvironment} onSubmit={propose} />
        ) : null}
      </div>
      {message ? <Alert tone={message.tone === 'info' ? 'info' : undefined}>{message.text}</Alert> : null}
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Requests</h2>
        <QueryState query={actions} label="Loading actions">
          <ActionList
            actions={rows}
            currentUserId={me.data?.user.id ?? null}
            canApprove={roleCan(role, 'action.propose')}
            href={(id) => `/orgs/${orgId}/products/${productId}/automations/${id}`}
            onApprove={(id) =>
              run(async () =>
                unwrap(
                  await api.POST('/api/v1/actions/{id}/approve', { params: { path: { id } }, body: {} }),
                ),
              )
            }
            onReject={(id, note) =>
              run(async () =>
                unwrap(
                  await api.POST('/api/v1/actions/{id}/reject', { params: { path: { id } }, body: { note } }),
                ),
              )
            }
          />
        </QueryState>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Policies</h2>
        <p className="text-sm text-muted-foreground">
          Everything is off until enabled here. A host also needs pcp-helper (install with{' '}
          <code>--enable-helper</code>) and the unit in its own <code>/etc/pcp-agent/helper.yaml</code>.
        </p>
        <QueryState query={policies} label="Loading policies">
          <PolicyList
            policies={policyRows}
            canManage={roleCan(role, 'org.settings.manage')}
            onSave={(capability: string, input: PolicyInput) =>
              run(async () =>
                unwrap(
                  await api.PUT('/api/v1/products/{id}/action-policies/{type}', {
                    params: { path: { id: productId, type: capability as 'host.restart_service' } },
                    body: input,
                  }),
                ),
              )
            }
          />
        </QueryState>
      </section>
    </div>
  );
}
