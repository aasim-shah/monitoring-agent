'use client';

import { PageDialog } from '@/components/shell/page-dialog';
import { PageHeading } from '@/components/shell/page-heading';

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
    <div className="portal-route portal-route-members">
      <PageHeading
        title={<>Members & Roles</>}
        description="Give people the access they need. Keep ownership clear."
        eyebrow="Workspace operations"
        action={
          canManage ? (
            <PageDialog
              label="Invite member"
              title="Invite a member"
              description="The invitation link expires in 7 days and works once."
            >
              <InviteForm orgId={orgId} actorRole={actorRole} products={products.data?.products ?? []} />
            </PageDialog>
          ) : undefined
        }
      />
      {error ? <Alert>{error}</Alert> : null}
      <QueryState query={members} label="Loading members">
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Product access</th>
                <th>Role & actions</th>
              </tr>
            </thead>
            <tbody>
              {members.data?.members.map((m) => {
                const manageable = canManage && rolesAtOrBelow(actorRole).includes(m.role as Role);
                const isSelf = m.userId === me.data?.user.id;
                return (
                  <tr key={m.id}>
                    <td>
                      <div>
                        <p className="text-sm font-medium">
                          {m.email} {isSelf ? <span className="text-muted-foreground">(you)</span> : null}
                        </p>
                      </div>
                    </td>
                    <td>{m.productIds === 'all' ? 'All products' : `${m.productIds.length} product(s)`}</td>
                    <td>
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </QueryState>
    </div>
  );
}
