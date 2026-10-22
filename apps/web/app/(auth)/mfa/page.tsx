'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { z } from 'zod';
import { unwrap } from '@pcp/api-client';
import { AuthCard } from '@/components/auth/auth-card';
import { SimpleForm } from '@/components/auth/simple-form';
import { ErrorState } from '@/components/states/error-state';
import { Loading } from '@/components/states/loading';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api, errorMessage, handleApiError } from '@/lib/api';
import { safeNext } from '@/lib/safe-next';

const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });
const recoverySchema = z.object({ recoveryCode: z.string().trim().min(10, 'Enter a recovery code') });

function Mfa() {
  const router = useRouter();
  const pathname = usePathname();
  const next = safeNext(useSearchParams().get('next'));
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: async () => unwrap(await api.GET('/api/v1/me')) });
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);

  const finish = async () => {
    await queryClient.invalidateQueries();
    router.replace(next);
  };

  if (me.isPending) return <Loading label="Loading your account" />;
  if (me.isError) {
    const err = handleApiError(me.error, router, pathname);
    return err ? <ErrorState error={err} onRetry={() => me.refetch()} /> : <Loading />;
  }

  if (recoveryCodes) {
    return (
      <AuthCard
        title="Save your recovery codes"
        description="Each code works once if you lose your authenticator. They will not be shown again."
      >
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm" data-testid="recovery-codes">
          {recoveryCodes.map((c) => (
            <li key={c} className="rounded bg-muted px-2 py-1">
              {c}
            </li>
          ))}
        </ul>
        <Button className="w-full" onClick={finish}>
          I saved these codes
        </Button>
      </AuthCard>
    );
  }

  if (me.data.user.mfaEnabled) {
    return (
      <AuthCard title="Two-factor authentication" description="Enter the code from your authenticator app.">
        {useRecovery ? (
          <SimpleForm
            schema={recoverySchema}
            defaults={{ recoveryCode: '' }}
            fields={[{ name: 'recoveryCode', label: 'Recovery code', autoComplete: 'one-time-code' }]}
            submitLabel="Verify"
            pendingLabel="Verifying…"
            onSubmit={async (body) => {
              unwrap(await api.POST('/api/v1/auth/mfa/verify', { body }));
              await finish();
            }}
          />
        ) : (
          <SimpleForm
            schema={codeSchema}
            defaults={{ code: '' }}
            fields={[{ name: 'code', label: 'Authentication code', autoComplete: 'one-time-code' }]}
            submitLabel="Verify"
            pendingLabel="Verifying…"
            onSubmit={async (body) => {
              unwrap(await api.POST('/api/v1/auth/mfa/verify', { body }));
              await finish();
            }}
          />
        )}
        <Button variant="ghost" className="w-full" onClick={() => setUseRecovery((v) => !v)}>
          {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set up two-factor authentication"
      description="Owners and admins must use an authenticator app. Scan the key into your app, then enter the code it shows."
    >
      {startError ? <Alert>{errorMessage(startError)}</Alert> : null}
      {enrollment ? (
        <>
          <div className="space-y-2">
            <p className="text-sm">Setup key</p>
            <code className="block break-all rounded bg-muted px-2 py-1 text-sm" data-testid="mfa-secret">
              {enrollment.secret}
            </code>
            <a className="text-sm underline" href={enrollment.otpauthUri}>
              Open in authenticator app
            </a>
          </div>
          <SimpleForm
            schema={codeSchema}
            defaults={{ code: '' }}
            fields={[{ name: 'code', label: 'Authentication code', autoComplete: 'one-time-code' }]}
            submitLabel="Turn on two-factor authentication"
            pendingLabel="Verifying…"
            onSubmit={async (body) => {
              const result = unwrap(await api.POST('/api/v1/auth/mfa/verify', { body }));
              setRecoveryCodes(result.recoveryCodes ?? []);
            }}
          />
        </>
      ) : (
        <Button
          className="w-full"
          onClick={async () => {
            try {
              setStartError(null);
              setEnrollment(unwrap(await api.POST('/api/v1/auth/mfa/enroll')));
            } catch (e) {
              setStartError(e);
            }
          }}
        >
          Set up authenticator app
        </Button>
      )}
    </AuthCard>
  );
}

export default function MfaPage() {
  return (
    <Suspense>
      <Mfa />
    </Suspense>
  );
}
