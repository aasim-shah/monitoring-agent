'use client';

import { PageHeading, PageMetrics } from '@/components/shell/page-heading';

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
    <div className="portal-route portal-route-overview">
      <PageHeading
        title={<>Workspace overview</>}
        description="A home for your products, people, and connected operations."
        eyebrow="Workspace"
      />
      {products.data && (
        <PageMetrics
          items={[
            { label: 'Products', value: products.data.products.length, detail: 'In this workspace' },
            { label: 'Your role', value: org.data?.role ?? '—', detail: 'Workspace access' },
            {
              label: 'Environments',
              value: products.data.products.reduce((sum, p) => sum + p.environmentCount, 0),
              detail: 'Across your products',
            },
          ]}
        />
      )}
      <h2 className="portal-section-title">Products</h2>
      <div className="portal-products-grid">
        <div>
          <QueryState query={products} label="Loading products">
            {products.data?.products.length === 0 ? (
              <Empty
                title="No products yet"
                description="A product groups the websites, apps, services, and infrastructure you monitor."
              />
            ) : (
              <ul className="portal-product-list">
                {products.data?.products.map((p) => (
                  <li key={p.id}>
                    <Link href={`/orgs/${orgId}/products/${p.id}`}>
                      <Card className="portal-product-card p-6 hover:bg-muted">
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
        </div>
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
    </div>
  );
}
