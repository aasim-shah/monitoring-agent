'use client';
import { usePathname } from 'next/navigation';
import { useProducts } from '@/lib/queries';
import { PortalTheme } from './portal-theme';

const titles: Record<string, string> = {
  agents: 'Agents',
  assets: 'Assets',
  aws: 'AWS',
  infrastructure: 'Infrastructure',
  websites: 'Websites & APIs',
  mobile: 'Mobile Apps & SDKs',
  databases: 'Databases',
  analytics: 'Analytics & Ads',
  incidents: 'Incidents & Alerts',
  ai: 'AI Assistant',
  reports: 'Reports',
  automations: 'Automations & Approvals',
  integrations: 'Integrations',
  members: 'Members & Roles',
  settings: 'Settings',
  notifications: 'Notifications',
  usage: 'Usage',
  audit: 'Audit log',
  'alert-rules': 'Alert rules',
};
export function PortalTopbar({
  organization,
  orgId,
  productId,
}: {
  organization: string;
  orgId: string;
  productId?: string;
}) {
  const path = usePathname();
  const products = useProducts(orgId);
  const product = products.data?.products.find((p) => p.id === productId);
  const parts = path.split('/');
  const leaf = parts.at(-1) ?? '';
  const label =
    titles[leaf] ?? (productId === leaf ? 'Health overview' : (titles[parts.at(-2) ?? ''] ?? 'Overview'));
  return (
    <header className="portal-topbar">
      <div className="portal-breadcrumbs">
        <span>{organization}</span>
        {product && (
          <>
            <i>/</i>
            <span>{product.name}</span>
          </>
        )}
        <i>/</i>
        <strong>{label}</strong>
      </div>
      <PortalTheme />
    </header>
  );
}
