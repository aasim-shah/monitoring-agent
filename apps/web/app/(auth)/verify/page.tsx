'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { unwrap } from '@pcp/api-client';
import { AuthCard } from '@/components/auth/auth-card';
import { Loading } from '@/components/states/loading';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { useOnce } from '@/lib/use-once';

function Verify() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<{ status: 'pending' | 'done' | 'error'; error?: unknown }>({
    status: 'pending',
  });
  useOnce(() => {
    if (!token) return setState({ status: 'error', error: new Error('missing token') });
    api
      .POST('/api/v1/auth/verify', { body: { token } })
      .then((r) => (unwrap(r), setState({ status: 'done' })))
      .catch((error) => setState({ status: 'error', error }));
  });
  return (
    <AuthCard title="Verify your email">
      {state.status === 'pending' ? <Loading label="Verifying" /> : null}
      {state.status === 'done' ? (
        <>
          <Alert tone="success">Your email is verified.</Alert>
          <Button asChild className="w-full">
            <Link href="/login">Sign in</Link>
          </Button>
        </>
      ) : null}
      {state.status === 'error' ? (
        <Alert>{token ? errorMessage(state.error) : 'The link is missing its token.'}</Alert>
      ) : null}
    </AuthCard>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
