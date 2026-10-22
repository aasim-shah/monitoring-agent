'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from '@/lib/nav';
import { cn } from '@/lib/cn';
import { Badge } from '../ui/badge';

export function SideNav({ title, items }: { title: string; items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={title} className="space-y-1">
      <p className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="space-y-0.5">
        {items.map((item) =>
          item.href ? (
            <li key={item.label}>
              <Link
                href={item.href}
                aria-current={pathname === item.href ? 'page' : undefined}
                className={cn(
                  'block rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                  pathname === item.href && 'bg-muted font-medium',
                )}
              >
                {item.label}
              </Link>
            </li>
          ) : (
            <li
              key={item.label}
              aria-disabled
              className="flex items-center justify-between px-2 py-1.5 text-sm text-muted-foreground"
            >
              <span>{item.label}</span>
              <Badge title={`Arrives in milestone ${item.milestone}`}>{item.milestone}</Badge>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
