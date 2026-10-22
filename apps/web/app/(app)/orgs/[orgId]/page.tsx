'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Role } from '@pcp/shared-contracts';
import { CreateProductForm } from '@/components/products/create-product-form';
import { Empty } from '@/components/states/empty';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { QueryState } from '@/lib/page-guard';
import { roleCan } from '@/lib/permissions';
import { useOrganization, useProducts } from '@/lib/queries';

export default function OrganizationOverviewPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const org = useOrganization(orgId);
  const products = useProducts(orgId);
  const canManage = org.data ? roleCan(org.data.role as Role, 'product.manage') : false;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">Products</h1>
        <QueryState query={products} label="Loading products">
          {products.data?.products.length === 0 ? (
            <Empty
              title="No products yet"
              description="A product groups the websites, apps, services, and infrastructure you monitor."
            />
          ) : (
            <ul className="space-y-2">
              {products.data?.products.map((p) => (
                <li key={p.id}>
                  <Link href={`/orgs/${orgId}/products/${p.id}`}>
                    <Card className="flex items-center justify-between p-4 hover:bg-muted">
                      <div>
                        <p className="font-medium">{p.name}</p>
                        {p.domains.length ? (
                          <p className="text-xs text-muted-foreground">{p.domains.join(', ')}</p>
                        ) : null}
                      </div>
                      <Badge>
                        {p.environmentCount} environment{p.environmentCount === 1 ? '' : 's'}
                      </Badge>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </section>
      {canManage ? (
        <Card className="h-fit space-y-4">
          <div>
            <CardTitle>New product</CardTitle>
            <CardDescription>
              For example FireMaps: its website, apps, APIs, and infrastructure.
            </CardDescription>
          </div>
          <CreateProductForm orgId={orgId} />
        </Card>
      ) : null}
    </div>
  );
}
