'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { z } from 'zod';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { SimpleForm } from '@/components/auth/simple-form';
import { SetupChecklist } from '@/components/products/setup-checklist';
import { Empty } from '@/components/states/empty';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization } from '@/lib/queries';
import { buildSetupSteps } from '@/lib/setup-steps';
import { useApiQuery } from '@/lib/use-api-query';

const envSchema = z.object({ name: z.string().trim().min(1, 'Enter a name').max(50) });

export default function ProductPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  const queryClient = useQueryClient();
  const org = useOrganization(orgId);
  const product = useApiQuery(['product', productId], async () =>
    unwrap(await api.GET('/api/v1/products/{productId}', { params: { path: { productId } } })),
  );
  const canManage = org.data ? roleCan(org.data.role as Role, 'product.manage') : false;
  const p = product.data;
  return (
    <QueryState query={product} label="Loading product">
      {p ? (
        <div className="space-y-6">
          <div>
            <h1 className="text-xl font-semibold">{p.name}</h1>
            {p.description ? <p className="text-sm text-muted-foreground">{p.description}</p> : null}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="space-y-2">
              <CardTitle className="text-base">Domains</CardTitle>
              <CardDescription>Discovery hints; verified when integrations connect.</CardDescription>
              <div className="flex flex-wrap gap-2">
                {p.domains.length ? (
                  p.domains.map((d) => <Badge key={d}>{d}</Badge>)
                ) : (
                  <span className="text-sm text-muted-foreground">None</span>
                )}
              </div>
            </Card>
            <Card className="space-y-2">
              <CardTitle className="text-base">Repositories</CardTitle>
              <div className="flex flex-wrap gap-2">
                {p.repositories.length ? (
                  p.repositories.map((r) => <Badge key={r}>{r}</Badge>)
                ) : (
                  <span className="text-sm text-muted-foreground">None</span>
                )}
              </div>
            </Card>
          </div>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Environments</h2>
            {(p.environments ?? []).length === 0 ? (
              <Empty
                title="No environments yet"
                description="Add Production and Staging to separate their monitoring."
              />
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label="Environments">
                {(p.environments ?? []).map((e) => (
                  <li key={e.id}>
                    <Badge className="px-3 py-1 text-sm text-foreground">{e.name}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              <Card className="max-w-sm">
                <SimpleForm
                  schema={envSchema}
                  defaults={{ name: '' }}
                  fields={[{ name: 'name', label: 'New environment' }]}
                  submitLabel="Add environment"
                  pendingLabel="Adding…"
                  onSubmit={async (body) => {
                    unwrap(
                      await api.POST('/api/v1/products/{productId}/environments', {
                        params: { path: { productId } },
                        body,
                      }),
                    );
                    await queryClient.invalidateQueries({ queryKey: ['product', productId] });
                    await queryClient.invalidateQueries({ queryKey: ['products', orgId] });
                  }}
                />
              </Card>
            ) : null}
          </section>
          <SetupChecklist
            steps={buildSetupSteps({
              orgId,
              productId,
              environments: (p.environments ?? []).length,
              canManage,
            })}
          />
        </div>
      ) : null}
    </QueryState>
  );
}
