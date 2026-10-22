'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { unwrap } from '@pcp/api-client';
import { AuthCard } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/login-form';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { safeNext } from '@/lib/safe-next';

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
      {process.env.NEXT_PUBLIC_GOOGLE_LOGIN === '1' ? (
        <Button variant="outline" className="w-full" asChild>
          <a href="/api/v1/auth/google/start">Continue with Google</a>
        </Button>
      ) : null}
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
