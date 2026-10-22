'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { z } from 'zod';
import { unwrap } from '@pcp/api-client';
import { AuthCard } from '@/components/auth/auth-card';
import { SimpleForm } from '@/components/auth/simple-form';
import { Alert } from '@/components/ui/alert';
import { api } from '@/lib/api';

const requestSchema = z.object({ email: z.string().trim().email('Enter a valid email address') });
const resetSchema = z.object({ password: z.string().min(12, 'Use at least 12 characters').max(256) });

function Reset() {
  const token = useSearchParams().get('token');
  const [done, setDone] = useState(false);
  const footer = (
    <Link className="underline" href="/login">
      Back to sign in
    </Link>
  );
  if (token) {
    return (
      <AuthCard title="Choose a new password" footer={footer}>
        {done ? (
          <Alert tone="success">
            Password changed. Sign in with your new password; other sessions were signed out.
          </Alert>
        ) : (
          <SimpleForm
            schema={resetSchema}
            defaults={{ password: '' }}
            fields={[
              { name: 'password', label: 'New password', type: 'password', autoComplete: 'new-password' },
            ]}
            submitLabel="Change password"
            pendingLabel="Changing…"
            onSubmit={async ({ password }) => {
              unwrap(await api.POST('/api/v1/auth/password/reset', { body: { token, password } }));
              setDone(true);
            }}
          />
        )}
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Reset your password" footer={footer}>
      {done ? (
        <Alert tone="success">If an account exists for that email, a reset link is on its way.</Alert>
      ) : (
        <SimpleForm
          schema={requestSchema}
          defaults={{ email: '' }}
          fields={[{ name: 'email', label: 'Email', type: 'email', autoComplete: 'email' }]}
          submitLabel="Send reset link"
          pendingLabel="Sending…"
          onSubmit={async (body) => {
            unwrap(await api.POST('/api/v1/auth/password/reset-request', { body }));
            setDone(true);
          }}
        />
      )}
    </AuthCard>
  );
}

export default function ResetPage() {
  return (
    <Suspense>
      <Reset />
    </Suspense>
  );
}
