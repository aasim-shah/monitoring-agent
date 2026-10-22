'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { InviteForm } from '@/components/members/invite-form';
import { RoleSelect } from '@/components/members/role-select';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { ROLE_LABELS, rolesAtOrBelow } from '@/lib/roles';
import { useMe, useOrganization, useProducts } from '@/lib/queries';
import { useApiQuery } from '@/lib/use-api-query';

export default function MembersPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const queryClient = useQueryClient();
  const me = useMe();
  const org = useOrganization(orgId);
  const products = useProducts(orgId);
  const members = useApiQuery(['members', orgId], async () =>
    unwrap(await api.GET('/api/v1/organizations/{orgId}/members', { params: { path: { orgId } } })),
  );
  const [error, setError] = useState<string | null>(null);
  const actorRole = (org.data?.role ?? 'viewer') as Role;
  const canManage = roleCan(actorRole, 'org.members.manage');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members', orgId] });

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">Members & Roles</h1>
        {error ? <Alert>{error}</Alert> : null}
        <QueryState query={members} label="Loading members">
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {members.data?.members.map((m) => {
              const manageable = canManage && rolesAtOrBelow(actorRole).includes(m.role as Role);
              const isSelf = m.userId === me.data?.user.id;
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">
                      {m.email} {isSelf ? <span className="text-muted-foreground">(you)</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {m.productIds === 'all' ? 'All products' : `${m.productIds.length} product(s)`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {manageable ? (
                      <RoleSelect
                        id={`role-${m.id}`}
                        actorRole={actorRole}
                        value={m.role as Role}
                        onChange={(role) =>
                          run(async () =>
                            unwrap(
                              await api.PATCH('/api/v1/organizations/{orgId}/members/{memberId}', {
                                params: { path: { orgId, memberId: m.id } },
                                body: { role },
                              }),
                            ),
                          )
                        }
                      />
                    ) : (
                      <Badge>{ROLE_LABELS[m.role as Role]}</Badge>
                    )}
                    {manageable ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          run(async () =>
                            unwrap(
                              await api.DELETE('/api/v1/organizations/{orgId}/members/{memberId}', {
                                params: { path: { orgId, memberId: m.id } },
                              }),
                            ),
                          )
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </QueryState>
      </section>
      {canManage ? (
        <Card className="h-fit space-y-4">
          <div>
            <CardTitle>Invite a member</CardTitle>
            <CardDescription>The invitation link expires in 7 days and works once.</CardDescription>
          </div>
          <InviteForm orgId={orgId} actorRole={actorRole} products={products.data?.products ?? []} />
        </Card>
      ) : null}
    </div>
  );
}
