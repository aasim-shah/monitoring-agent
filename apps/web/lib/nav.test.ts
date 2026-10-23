import { describe, expect, it } from 'vitest';
import { buildOrgNav, buildProductNav } from './nav';

const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe('organization navigation', () => {
  it('shows members, audit log, and settings to owners', () => {
    expect(labels(buildOrgNav('o', 'owner'))).toEqual([
      'Overview',
      'Members & Roles',
      'Audit Log',
      'Settings',
      'Notifications',
    ]);
    expect(buildOrgNav('o', 'owner').at(-1)).toEqual({
      label: 'Notifications',
      href: '/orgs/o/settings/notifications',
    });
  });

  it('hides audit log and settings from viewers (UI only; the API also refuses)', () => {
    expect(labels(buildOrgNav('o', 'viewer'))).toEqual(['Overview', 'Members & Roles']);
  });
});

describe('product navigation (spec §21)', () => {
  it('lists every section in order; unbuilt ones are disabled with their milestone', () => {
    const items = buildProductNav('o', 'p', 'owner');
    expect(labels(items)).toEqual([
      'Health Overview',
      'Integrations',
      'Agents',
      'Assets',
      'Infrastructure',
      'Websites & APIs',
      'Mobile Apps & SDKs',
      'Databases',
      'Analytics & Ads',
      'Incidents & Alerts',
      'AI Assistant',
      'Reports & Schedules',
      'Automations & Approvals',
      'Audit Log',
    ]);
    expect(items[0]).toEqual({ label: 'Health Overview', href: '/orgs/o/products/p' });
    expect(items.find((i) => i.label === 'Agents')).toEqual({
      label: 'Agents',
      href: '/orgs/o/products/p/agents',
    });
    expect(items.find((i) => i.label === 'Integrations')).toEqual({ label: 'Integrations', milestone: 'M7' });
    expect(items.find((i) => i.label === 'Infrastructure')).toEqual({
      label: 'Infrastructure',
      href: '/orgs/o/products/p/infrastructure',
    });
    expect(items.filter((i) => i.href).map((i) => i.label)).toEqual([
      'Health Overview',
      'Agents',
      'Assets',
      'Infrastructure',
      'Databases',
      'Incidents & Alerts',
      'Audit Log',
    ]);
    expect(items.find((i) => i.label === 'Incidents & Alerts')).toEqual({
      label: 'Incidents & Alerts',
      href: '/orgs/o/products/p/incidents',
    });
  });

  it('omits the audit log for roles without audit.view', () => {
    expect(labels(buildProductNav('o', 'p', 'analyst'))).not.toContain('Audit Log');
  });
});
