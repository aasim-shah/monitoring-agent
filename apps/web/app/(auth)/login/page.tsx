'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { unwrap } from '@pcp/api-client';
import { AuthCard } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/login-form';
import { SsoButtons, type Providers } from '@/components/auth/sso-buttons';
import { api } from '@/lib/api';
import { safeNext } from '@/lib/safe-next';

const loadProviders = async (): Promise<Providers> => {
  const res = await fetch('/api/v1/auth/providers', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`providers ${res.status}`);
  return (await res.json()) as Providers;
};

function Login() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  return (
    <AuthCard
      title="Sign in"
      footer={
        <>
          <Link className="underline" href="/signup">
            Create an account
          </Link>{' '}
          ·{' '}
          <Link className="underline" href="/reset">
            Forgot password
          </Link>
        </>
      }
    >
      <LoginForm
        onSubmit={async (body) => unwrap(await api.POST('/api/v1/auth/login', { body }))}
        onSuccess={(mfaRequired) =>
          router.replace(mfaRequired ? `/mfa?next=${encodeURIComponent(next)}` : next)
        }
      />
      <SsoButtons load={loadProviders} />
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
