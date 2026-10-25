'use client';

import { LumenIcon } from '@lumen/icons/react';
import { useRouter } from 'next/navigation';
import { useMe, useProducts } from '@/lib/queries';

const selectClass = 'h-8 rounded-md border border-border bg-background px-2 text-sm';

/** Organization → product switcher (spec §21). Environments are chosen on the product page. */
export function ContextSwitcher({ orgId, productId }: { orgId: string; productId?: string }) {
  const router = useRouter();
  const me = useMe();
  const products = useProducts(orgId);
  const product = products.data?.products.find((p) => p.id === productId);
  const organization = me.data?.memberships.find((m) => m.organizationId === orgId)?.organizationName;
  return (
    <details className="portal-context-picker">
      <summary>
        <span className="portal-context-icon">
          <LumenIcon name="grid" size={18} />
        </span>
        <span>
          <strong>{product?.name ?? 'All products'}</strong>
          <small>{organization ?? 'Workspace'}</small>
        </span>
        <LumenIcon name="chevron-down" size={16} />
      </summary>
      <div className="portal-context-menu">
        <div className="portal-context flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="org-switcher">
            Organization
          </label>
          <select
            id="org-switcher"
            className={selectClass}
            value={orgId}
            onChange={(e) => router.push(`/orgs/${e.target.value}`)}
          >
            {(me.data?.memberships ?? []).map((m) => (
              <option key={m.organizationId} value={m.organizationId}>
                {m.organizationName}
              </option>
            ))}
          </select>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <label className="sr-only" htmlFor="product-switcher">
            Product
          </label>
          <select
            id="product-switcher"
            className={selectClass}
            value={productId ?? ''}
            onChange={(e) =>
              router.push(e.target.value ? `/orgs/${orgId}/products/${e.target.value}` : `/orgs/${orgId}`)
            }
          >
            <option value="">All products</option>
            {(products.data?.products ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </details>
  );
}
