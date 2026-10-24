'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import type { IntegrationSpec } from '@/lib/integrations';

export interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
  required?: boolean;
}

export interface NewIntegration {
  provider: IntegrationSpec['provider'];
  displayName: string;
  config: Record<string, unknown>;
  /** Sent only to the credentials endpoint (encrypted at rest). */
  credentials: Record<string, string>;
}

/** Credentials form shared by the connect wizard and "Replace credentials" on the detail page. */
export function CredentialInputs({
  fields,
  values,
  onChange,
  idPrefix,
}: {
  fields: CredentialField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  idPrefix: string;
}) {
  return (
    <>
      {fields.map((f) => (
        <Field
          key={f.name}
          id={`${idPrefix}-${f.name}`}
          label={f.label}
          hint={f.required === false ? 'Optional' : undefined}
        >
          <Input
            id={`${idPrefix}-${f.name}`}
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            value={values[f.name] ?? ''}
            onChange={(e) => onChange(f.name, e.target.value)}
          />
        </Field>
      ))}
    </>
  );
}

/** Returns the first problem with the credentials, or null. */
export function missingCredential(fields: CredentialField[], values: Record<string, string>) {
  const f = fields.find((x) => x.required !== false && !values[x.name]?.trim());
  return f ? `${f.label} is required` : null;
}

export const filled = (values: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(values)
      .map(([k, v]) => [k, v.trim()])
      .filter(([, v]) => v),
  );

/** The connect wizard: what is asked, where it runs, what it collects and changes, then the token. */
export function ConnectDialog({
  spec,
  credentialFields,
  onSubmit,
}: {
  spec: IntegrationSpec;
  credentialFields: CredentialField[];
  onSubmit: (input: NewIntegration) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const missingConfig = spec.configFields.find((f) => f.required && !config[f.name]?.trim());
    if (missingConfig) return setError(`${missingConfig.label} is required`);
    const missing = missingCredential(credentialFields, credentials);
    if (missing) return setError(missing);
    const cfg: Record<string, unknown> = {};
    for (const f of spec.configFields) {
      const v = config[f.name]?.trim();
      if (!v) continue;
      cfg[f.name] = f.list
        ? v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : v;
    }
    setError(null);
    setPending(true);
    try {
      await onSubmit({
        provider: spec.provider,
        displayName: spec.displayName(cfg),
        config: cfg,
        credentials: filled(credentials),
      });
      setOpen(false);
      setConfig({});
      setCredentials({});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Connect {spec.title}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>Connect {spec.title}</DialogTitle>
        <DialogDescription>{spec.summary}</DialogDescription>
        <div className="space-y-4 text-sm">
          <section className="space-y-1">
            <h3 className="font-medium">Token permissions</h3>
            <ul aria-label="Token permissions" className="list-disc space-y-0.5 pl-5 font-mono text-xs">
              {spec.permissions.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {spec.optionalPermissions?.length ? (
              <ul aria-label="Optional permissions" className="list-disc pl-5 text-xs text-muted-foreground">
                {spec.optionalPermissions.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">{spec.tokenHelp}</p>
          </section>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Where it runs</dt>
            <dd>Runs in the cloud, from the platform&apos;s servers.</dd>
            <dt className="text-muted-foreground">Data collected</dt>
            <dd>{spec.collects}</dd>
            <dt className="text-muted-foreground">How often</dt>
            <dd>{spec.frequency}</dd>
            <dt className="text-muted-foreground">Changes</dt>
            <dd>{spec.changes}</dd>
          </dl>
          {spec.configFields.map((f) => (
            <Field key={f.name} id={`cfg-${f.name}`} label={f.label} hint={f.hint}>
              <Input
                id={`cfg-${f.name}`}
                placeholder={f.placeholder}
                value={config[f.name] ?? ''}
                onChange={(e) => setConfig((c) => ({ ...c, [f.name]: e.target.value }))}
              />
            </Field>
          ))}
          <CredentialInputs
            fields={credentialFields}
            values={credentials}
            idPrefix="cred"
            onChange={(name, value) => setCredentials((c) => ({ ...c, [name]: value }))}
          />
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={submit} disabled={pending}>
              {pending ? 'Saving…' : 'Save and validate'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
