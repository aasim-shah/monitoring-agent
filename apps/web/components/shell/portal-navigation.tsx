'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import Link from 'next/link';
import { Menu, X, ChevronDown } from 'lucide-react';
import { LumenIcon, type IconName } from '@lumen/icons/react';
import type { NavItem } from '@/lib/nav';
import { SideNav } from './side-nav';
import { ContextSwitcher } from './context-switcher';
import { useParams } from 'next/navigation';
import { useMe } from '@/lib/queries';

const icons: IconName[] = [
  'home',
  'link',
  'wifi',
  'grid',
  'cloud',
  'globe',
  'phone',
  'archive',
  'chart',
  'bell',
  'sparkle',
  'file',
  'shield',
];
const labels = [
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
];
const groups = [
  { title: 'Observe', labels: labels.filter((_, i) => [0, 3, 4, 5, 6, 7, 8].includes(i)) },
  { title: 'Operate', labels: labels.slice(9) },
  { title: 'Setup', labels: labels.slice(1, 3) },
];
export function PortalNavigation({
  organization,
  orgItems,
  productItems,
}: {
  organization: string;
  orgItems: NavItem[];
  productItems: NavItem[];
}) {
  const pathname = usePathname();
  const { orgId, productId } = useParams<{ orgId: string; productId?: string }>();
  const me = useMe();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
      if (e.key === 'Tab') {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('a,button,summary') ?? [])].filter(
          (x) => x.getClientRects().length,
        );
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handle);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener('keydown', handle);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="portal-menu-trigger"
        aria-controls="portal-sidebar"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Menu size={18} /> Navigation
      </button>
      {open && (
        <button
          className="portal-backdrop"
          aria-label="Close navigation"
          onClick={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
      <aside
        ref={panel}
        id="portal-sidebar"
        className={`portal-sidebar ${open ? 'is-open' : ''}`}
        aria-label="Workspace navigation"
      >
        <Link className="portal-sidebar-wordmark" href="/orgs">
          Product Control Plane
        </Link>
        <ContextSwitcher orgId={orgId} productId={productId} />
        <div className="portal-sidebar-title">
          <span>{organization}</span>
          <button
            type="button"
            className="portal-menu-close"
            aria-label="Close navigation"
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          >
            <X size={18} />
          </button>
        </div>
        {productItems.length ? (
          <>
            {groups.map((group) => (
              <nav key={group.title} aria-label={group.title} className="portal-nav-group">
                <p>{group.title}</p>
                {group.labels.map((label) => {
                  const item = productItems.find((i) => i.label === label);
                  if (!item) return null;
                  const icon = icons[labels.indexOf(label)] ?? 'grid';
                  return item.href ? (
                    <Link
                      key={label}
                      href={item.href}
                      aria-current={pathname === item.href ? 'page' : undefined}
                    >
                      <LumenIcon name={icon} size={18} />
                      <span>{label}</span>
                    </Link>
                  ) : (
                    <span key={label} className="portal-nav-disabled" aria-disabled="true">
                      <LumenIcon name={icon} size={18} />
                      {label}
                    </span>
                  );
                })}
              </nav>
            ))}
            <details className="portal-workspace-nav" open={orgItems.some((i) => i.href === pathname)}>
              <summary>
                Workspace <ChevronDown size={14} />
              </summary>
              <SideNav title={organization} items={orgItems} />
            </details>
          </>
        ) : (
          <SideNav title="Workspace" items={orgItems} />
        )}
        <div className="portal-sidebar-account">
          <span className="portal-avatar">
            {(me.data?.user.email ?? organization).slice(0, 2).toUpperCase()}
          </span>
          <div>
            <strong>{me.data?.user.email ?? organization}</strong>
            <button
              type="button"
              className="portal-signout"
              onClick={async () => {
                await api.POST('/api/v1/auth/logout');
                queryClient.clear();
                router.replace('/login');
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
