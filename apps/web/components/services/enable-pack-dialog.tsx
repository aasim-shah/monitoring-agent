'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import type { CatalogPack } from './services-panel';

export interface EnablePackBody {
  packId: string;
  settings: Record<string, unknown>;
  sealedCredentials?: string;
}

/**
 * Endpoint and credentials for one pack. Credentials are sealed in the browser to the
 * agent's key before anything is sent (BR-11-03); the plaintext never leaves this dialog.
 */
export function EnablePackDialog({
  pack,
  updating,
  onClose,
  seal,
  onSubmit,
}: {
  pack: CatalogPack;
  updating: boolean;
  onClose: () => void;
  seal: (fields: Record<string, string>) => Promise<string>;
  onSubmit: (body: EnablePackBody) => Promise<void>;
}) {
  const [endpoint, setEndpoint] = useState(pack.defaultEndpoint ?? '');
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const filled = Object.fromEntries(Object.entries(creds).filter(([, v]) => v !== ''));
    // On an update, empty credentials keep the ones the agent already holds.
    const missing = updating ? undefined : pack.credentialFields.find((f) => f.required && !filled[f.name]);
    if (missing) {
      setError(`${missing.label} is required`);
      return;
    }
    if (pack.defaultEndpoint !== null && !endpoint.trim()) {
      setError('Endpoint is required');
      return;
    }
    setError(null);
    setPending(true);
    try {
      const body: EnablePackBody = {
        packId: pack.id,
        settings: pack.defaultEndpoint === null ? {} : { endpoint: endpoint.trim() },
      };
      if (Object.keys(filled).length) body.sealedCredentials = await seal(filled);
      await onSubmit(body);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent aria-describedby="enable-pack-description">
        <DialogTitle>
          {updating ? 'Change' : 'Monitor'} {pack.name}
        </DialogTitle>
        <DialogDescription id="enable-pack-description">{pack.description}</DialogDescription>
        <div className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          {pack.defaultEndpoint !== null ? (
            <Field
              id="pack-endpoint"
              label="Endpoint"
              hint="The agent connects from this server; loopback by default."
            >
              <Input id="pack-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            </Field>
          ) : null}
          {pack.credentialFields.map((f) => (
            <Field key={f.name} id={`pack-cred-${f.name}`} label={f.label}>
              <Input
                id={`pack-cred-${f.name}`}
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                value={creds[f.name] ?? ''}
                onChange={(e) => setCreds({ ...creds, [f.name]: e.target.value })}
              />
            </Field>
          ))}
          {pack.credentialFields.length ? (
            <p className="text-xs text-muted-foreground">
              Encrypted in your browser so only this server&apos;s agent can read it.
              {updating ? ' Leave empty to keep the credentials the agent already has.' : ''}
            </p>
          ) : null}
          <Button className="w-full" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : updating ? 'Save' : 'Start monitoring'}
          </Button>
        </div>
        <div className="flex justify-end">
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
