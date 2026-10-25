'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { PortalTheme } from './portal-theme';
import { Button } from '../ui/button';

export function AppHeader() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  const params = useParams();
  if (params.orgId) return null;
  return (
    <header className="portal-header portal-account-header">
      <Link href="/orgs" className="text-sm font-semibold">
        Product Control Plane
      </Link>
      <div className="flex items-center gap-3 text-sm">
        <PortalTheme />
        {me.data ? <span className="portal-user text-muted-foreground">{me.data.user.email}</span> : null}
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await api.POST('/api/v1/auth/logout');
            queryClient.clear();
            router.replace('/login');
          }}
        >
          Sign out
        </Button>
      </div>
    </header>
  );
}
