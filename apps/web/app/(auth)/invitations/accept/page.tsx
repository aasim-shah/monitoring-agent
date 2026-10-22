'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { unwrap } from '@pcp/api-client';
import { AuthCard } from '@/components/auth/auth-card';
import { Loading } from '@/components/states/loading';
import { Alert } from '@/components/ui/alert';
import { api, errorMessage, handleApiError } from '@/lib/api';
import { useOnce } from '@/lib/use-once';

function Accept() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const [error, setError] = useState<unknown>(null);
  useOnce(() => {
    if (!token) return setError(new Error('missing token'));
    api
      .POST('/api/v1/invitations/accept', { body: { token } })
      .then((r) => router.replace(`/orgs/${unwrap(r).organizationId}`))
      .catch((e) => {
        const remaining = handleApiError(e, router, `/invitations/accept?${params.toString()}`);
        if (remaining) setError(remaining);
      });
  });
  return (
    <AuthCard
      title="Accept invitation"
      footer={
        <Link className="underline" href="/orgs">
          Go to your organizations
        </Link>
      }
    >
      {error ? (
        <Alert>{token ? errorMessage(error) : 'The link is missing its token.'}</Alert>
      ) : (
        <Loading label="Joining" />
      )}
    </AuthCard>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense>
      <Accept />
    </Suspense>
  );
}
