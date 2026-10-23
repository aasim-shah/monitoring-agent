'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { AddRuleDialog } from '@/components/alerting/add-rule-dialog';
import { RuleList, type AlertTemplate, type RuleRow } from '@/components/alerting/rule-list';
import { Alert } from '@/components/ui/alert';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

export default function AlertRulesPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const role = (org.data?.role ?? 'viewer') as Role;
  const canManage = roleCan(role, 'incident.manage');
  const [error, setError] = useState<string | null>(null);
  const key = ['alert-rules', productId];
  const rules = useApiQuery(key, async () =>
    unwrap(await api.GET('/api/v1/products/{id}/alert-rules', { params: { path: { id: productId } } })),
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const templates = (rules.data?.templates ?? []) as AlertTemplate[];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link
            className="text-sm text-primary hover:underline"
            href={`/orgs/${orgId}/products/${productId}/incidents`}
          >
            ← Incidents
          </Link>
          <h1 className="text-xl font-semibold">Alert rules</h1>
          <p className="text-sm text-muted-foreground">
            Evaluated every minute on this product&apos;s data. Notifications go to the{' '}
            <Link className="text-primary hover:underline" href={`/orgs/${orgId}/settings/notifications`}>
              organization&apos;s channels
            </Link>
            .
          </p>
        </div>
        {canManage && templates.length ? (
          <AddRuleDialog
            templates={templates}
            onSubmit={async (body) => {
              unwrap(
                await api.POST('/api/v1/products/{id}/alert-rules', {
                  params: { path: { id: productId } },
                  body,
                }),
              );
              await refresh();
            }}
          />
        ) : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <QueryState query={rules} label="Loading alert rules">
        <RuleList
          rules={(rules.data?.rules ?? []) as RuleRow[]}
          templates={templates}
          canManage={canManage}
          onToggle={(id, enabled) =>
            run(async () =>
              unwrap(
                await api.PATCH('/api/v1/alert-rules/{id}', { params: { path: { id } }, body: { enabled } }),
              ),
            )
          }
          onDelete={(id) =>
            run(async () =>
              unwrap(await api.DELETE('/api/v1/alert-rules/{id}', { params: { path: { id } } })),
            )
          }
          onAddRecommended={() =>
            run(async () =>
              unwrap(
                await api.POST('/api/v1/products/{id}/alert-rules/recommended', {
                  params: { path: { id: productId } },
                }),
              ),
            )
          }
        />
      </QueryState>
    </section>
  );
}
