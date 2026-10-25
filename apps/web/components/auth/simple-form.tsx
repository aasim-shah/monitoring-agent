'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactNode } from 'react';
import { useForm, type DefaultValues, type FieldValues, type Path } from 'react-hook-form';
import type { ZodType } from 'zod';
import { errorMessage } from '@/lib/api';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Input } from '../ui/input';

export interface FieldSpec<T> {
  name: Path<T>;
  label: string;
  type?: string;
  autoComplete?: string;
  hint?: string;
}

/** Small validated form for the auth pages: fields, submit with pending state, API error. */
export function SimpleForm<T extends FieldValues>({
  schema,
  defaults,
  fields,
  submitLabel,
  pendingLabel,
  onSubmit,
  children,
}: {
  schema: ZodType<T>;
  defaults: DefaultValues<T>;
  fields: FieldSpec<T>[];
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (values: T) => Promise<void>;
  children?: ReactNode;
}) {
  const form = useForm<T>({ resolver: zodResolver(schema as never), defaultValues: defaults });
  const [error, setError] = useState<unknown>(null);
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await onSubmit(values);
    } catch (e) {
      setError(e);
    }
  });
  return (
    <form onSubmit={submit} noValidate className="grid gap-5">
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {fields.map((f) => {
        const message = (errors[f.name] as { message?: string } | undefined)?.message;
        return (
          <Field key={f.name} id={f.name} label={f.label} error={message} hint={f.hint}>
            <Input
              id={f.name}
              type={f.type ?? 'text'}
              autoComplete={f.autoComplete}
              aria-invalid={Boolean(message)}
              {...form.register(f.name)}
            />
          </Field>
        );
      })}
      {children}
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
