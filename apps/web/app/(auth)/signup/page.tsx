'use client';

import Link from 'next/link';
import { useState } from 'react';
import { z } from 'zod';
import { unwrap } from '@pcp/api-client';
import { AuthCard } from '@/components/auth/auth-card';
import { SimpleForm } from '@/components/auth/simple-form';
import { Alert } from '@/components/ui/alert';
import { api } from '@/lib/api';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(12, 'Use at least 12 characters').max(256),
});

export default function SignupPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  return (
    <AuthCard
      title="Create your account"
      footer={
        <Link className="underline" href="/login">
          Already have an account? Sign in
        </Link>
      }
    >
      {sentTo ? (
        <Alert tone="success">Check {sentTo} for a verification link. It expires in 24 hours.</Alert>
      ) : (
        <SimpleForm
          schema={schema}
          defaults={{ email: '', password: '' }}
          fields={[
            { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
            {
              name: 'password',
              label: 'Password',
              type: 'password',
              autoComplete: 'new-password',
              hint: 'At least 12 characters',
            },
          ]}
          submitLabel="Create account"
          pendingLabel="Creating account…"
          onSubmit={async (body) => {
            unwrap(await api.POST('/api/v1/auth/signup', { body }));
            setSentTo(body.email);
          }}
        />
      )}
    </AuthCard>
  );
}
