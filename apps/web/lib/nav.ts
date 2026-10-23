import { can, type Permission, type Role, type TenantContext } from '@pcp/shared-contracts';

export interface NavItem {
  label: string;
  href?: string;
  /** Set for sections not built yet: the milestone that delivers them. */
  milestone?: string;
}

const ctx = (role: Role): TenantContext => ({
  organizationId: '',
  actor: { kind: 'user', userId: '' },
  roles: [role],
  productIds: 'all',
  environmentIds: 'all',
  requestId: '',
});

const allowed = (role: Role, permission?: Permission) => !permission || can(ctx(role), permission);

/** Organization-level navigation. Hiding is a convenience; the API enforces every permission. */
export function buildOrgNav(orgId: string, role: Role): NavItem[] {
  const base = `/orgs/${orgId}`;
  const items: Array<NavItem & { permission?: Permission }> = [
    { label: 'Overview', href: base },
    { label: 'Members & Roles', href: `${base}/members`, permission: 'org.view' },
    { label: 'Audit Log', href: `${base}/audit`, permission: 'audit.view' },
    { label: 'Settings', href: `${base}/settings`, permission: 'org.settings.manage' },
    { label: 'Notifications', href: `${base}/settings/notifications`, permission: 'org.settings.manage' },
  ];
  return items.filter((i) => allowed(role, i.permission)).map(({ permission: _p, ...item }) => item);
}

/** Product-level navigation in spec §21 order; unbuilt sections are disabled and labelled. */
export function buildProductNav(orgId: string, productId: string, role: Role): NavItem[] {
  const items: Array<NavItem & { permission?: Permission }> = [
    { label: 'Health Overview', href: `/orgs/${orgId}/products/${productId}` },
    { label: 'Integrations', milestone: 'M7' },
    { label: 'Agents', href: `/orgs/${orgId}/products/${productId}/agents`, permission: 'agent.view' },
    { label: 'Assets', href: `/orgs/${orgId}/products/${productId}/assets`, permission: 'asset.view' },
    {
      label: 'Infrastructure',
      href: `/orgs/${orgId}/products/${productId}/infrastructure`,
      permission: 'telemetry.query',
    },
    {
      label: 'Websites & APIs',
      href: `/orgs/${orgId}/products/${productId}/websites`,
      permission: 'telemetry.query',
    },
    { label: 'Mobile Apps & SDKs', milestone: 'M13' },
    {
      label: 'Databases',
      href: `/orgs/${orgId}/products/${productId}/databases`,
      permission: 'connection.view',
    },
    { label: 'Analytics & Ads', milestone: 'M13' },
    {
      label: 'Incidents & Alerts',
      href: `/orgs/${orgId}/products/${productId}/incidents`,
      permission: 'incident.view',
    },
    { label: 'AI Assistant', href: `/orgs/${orgId}/products/${productId}/ai`, permission: 'ai.use' },
    {
      label: 'Reports & Schedules',
      href: `/orgs/${orgId}/products/${productId}/reports`,
      permission: 'report.view',
    },
    { label: 'Automations & Approvals', milestone: 'M16' },
    { label: 'Audit Log', href: `/orgs/${orgId}/audit`, permission: 'audit.view' },
  ];
  return items.filter((i) => allowed(role, i.permission)).map(({ permission: _p, ...item }) => item);
}
