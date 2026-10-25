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

export type NewChannel =
  | { kind: 'email'; name: string; recipients: string[]; escalation: boolean }
  | { kind: 'slack' | 'webhook'; name: string; url: string; escalation: boolean };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

/** Email, Slack, or signed webhook (UC-13-09); a webhook's signing secret is shown once. */
export function AddChannelDialog({
  onSubmit,
}: {
  onSubmit: (channel: NewChannel) => Promise<{ signingSecret?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<NewChannel['kind']>('email');
  const [name, setName] = useState('');
  const [recipients, setRecipients] = useState('');
  const [url, setUrl] = useState('');
  const [escalation, setEscalation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const reset = () => {
    setKind('email');
    setName('');
    setRecipients('');
    setUrl('');
    setEscalation(false);
    setError(null);
    setSecret(null);
  };

  const submit = async () => {
    if (!name.trim()) return setError('Enter a name');
    let body: NewChannel;
    if (kind === 'email') {
      const list = recipients
        .split(/[,\s]+/)
        .map((r) => r.trim())
        .filter(Boolean);
      if (list.length === 0 || list.length > 10) return setError('Enter 1 to 10 email addresses');
      const bad = list.find((r) => !EMAIL.test(r));
      if (bad) return setError(`${bad} is not an email address`);
      body = { kind, name: name.trim(), recipients: list, escalation };
    } else {
      if (!/^https:\/\//i.test(url.trim())) return setError('Use an https:// URL');
      body = { kind, name: name.trim(), url: url.trim(), escalation };
    }
    setError(null);
    setPending(true);
    try {
      const created = await onSubmit(body);
      if (created.signingSecret) setSecret(created.signingSecret);
      else setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Add channel</Button>
      </DialogTrigger>
      <DialogContent aria-describedby="add-channel-description">
        <DialogTitle>Add notification channel</DialogTitle>
        <DialogDescription id="add-channel-description">
          Incidents notify every active channel; escalations go to escalation channels when you mark any.
        </DialogDescription>
        {secret ? (
          <div className="space-y-3">
            <Alert tone="success">Channel created.</Alert>
            <p className="text-sm">
              Signing secret, shown only now. Store it with the receiver to verify the{' '}
              <code>X-PCP-Signature</code> header (HMAC-SHA256 of <code>&lt;t&gt;.&lt;body&gt;</code>).
            </p>
            <pre className="overflow-auto break-all rounded-md border border-border bg-muted p-3 font-mono text-xs">
              {secret}
            </pre>
            <Button variant="outline" onClick={() => void navigator.clipboard.writeText(secret)}>
              Copy secret
            </Button>
          </div>
        ) : (
          <div className="portal-feature-section space-y-4">
            {error ? <Alert>{error}</Alert> : null}
            <Field id="channel-kind" label="Type">
              <select
                id="channel-kind"
                className={selectClass}
                value={kind}
                onChange={(e) => setKind(e.target.value as NewChannel['kind'])}
              >
                <option value="email">Email</option>
                <option value="slack">Slack (incoming webhook)</option>
                <option value="webhook">Webhook (signed JSON)</option>
              </select>
            </Field>
            <Field id="channel-name" label="Name">
              <Input id="channel-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {kind === 'email' ? (
              <Field
                id="channel-recipients"
                label="Recipients"
                hint="Up to 10 addresses, separated by commas."
              >
                <Input
                  id="channel-recipients"
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                />
              </Field>
            ) : (
              <Field
                id="channel-url"
                label="URL"
                hint={kind === 'slack' ? 'Slack → Apps → Incoming Webhooks.' : 'Receives a signed JSON POST.'}
              >
                <Input id="channel-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={escalation} onChange={(e) => setEscalation(e.target.checked)} />
              Escalation channel (critical incidents unacknowledged for 15 min)
            </label>
            <Button className="w-full" disabled={pending} onClick={submit}>
              {pending ? 'Saving…' : 'Save channel'}
            </Button>
          </div>
        )}
        <div className="flex justify-end">
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
