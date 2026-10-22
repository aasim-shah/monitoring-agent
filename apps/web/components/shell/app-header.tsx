'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { Button } from '../ui/button';

export function AppHeader() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
      <Link href="/orgs" className="text-sm font-semibold">
        Product Control Plane
      </Link>
      <div className="flex items-center gap-3 text-sm">
        {me.data ? <span className="text-muted-foreground">{me.data.user.email}</span> : null}
        <Button
          variant="ghost"
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
