'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export interface Providers {
  google: boolean;
  oidc: { name: string; startUrl: string } | null;
}

/** Google and OIDC sign-in, as this deployment configured them (read at runtime, M19.4). */
export function SsoButtons({ load }: { load: () => Promise<Providers> }) {
  const [providers, setProviders] = useState<Providers | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((p) => live && setProviders(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [load]);
  if (!providers) return null;
  return (
    <>
      {providers.oidc ? (
        <Button variant="outline" className="w-full" asChild>
          <a href={providers.oidc.startUrl}>{`Continue with ${providers.oidc.name}`}</a>
        </Button>
      ) : null}
      {providers.google ? (
        <Button variant="outline" className="w-full" asChild>
          <a href="/api/v1/auth/google/start">Continue with Google</a>
        </Button>
      ) : null}
    </>
  );
}
