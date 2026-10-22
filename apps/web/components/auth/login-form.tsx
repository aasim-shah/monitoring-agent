'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage } from '@/lib/api';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Input } from '../ui/input';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginValues = z.infer<typeof schema>;

export function LoginForm({
  onSubmit,
  onSuccess,
}: {
  onSubmit: (values: LoginValues) => Promise<{ mfaRequired: boolean }>;
  onSuccess: (mfaRequired: boolean) => void;
}) {
  const form = useForm<LoginValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });
  const [error, setError] = useState<unknown>(null);
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      onSuccess((await onSubmit(values)).mfaRequired);
    } catch (e) {
      setError(e);
    }
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <Field id="email" label="Email" error={errors.email?.message}>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          aria-invalid={Boolean(errors.email)}
          {...form.register('email')}
        />
      </Field>
      <Field id="password" label="Password" error={errors.password?.message}>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={Boolean(errors.password)}
          {...form.register('password')}
        />
      </Field>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
