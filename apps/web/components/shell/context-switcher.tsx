'use client';

import { useRouter } from 'next/navigation';
import { useMe, useProducts } from '@/lib/queries';

const selectClass = 'h-8 rounded-md border border-border bg-background px-2 text-sm';

/** Organization → product switcher (spec §21). Environments are chosen on the product page. */
export function ContextSwitcher({ orgId, productId }: { orgId: string; productId?: string }) {
  const router = useRouter();
  const me = useMe();
  const products = useProducts(orgId);
  return (
    <div className="flex flex-wrap items-center gap-2">
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
  );
}
