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
import { isLocalControlUrl } from '@/lib/reachability';
import { ansibleSnippet, cloudInitSnippet, composeSnippet, type InstallParams } from './fleet-snippets';
import { InstallCommand, Snippet } from './install-command';

export interface EnrollmentInput {
  environmentId: string;
  maxUses: number;
  expiresInMinutes: number;
}

export interface CreatedEnrollment {
  installCommand: string;
  expiresAt: string;
  maxUses: number;
  install: InstallParams;
}

const METHODS = ['One-liner', 'Ansible', 'cloud-init', 'Docker'] as const;
type Method = (typeof METHODS)[number];

/** UC-05-01..04: the same shown-once token as a one-liner or for the customer's fleet tooling. */
function InstallMethods({ created }: { created: CreatedEnrollment }) {
  const [method, setMethod] = useState<Method>('One-liner');
  const ansible = ansibleSnippet(created.install);
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Install method" className="flex flex-wrap gap-1">
        {METHODS.map((m) => (
          <Button
            key={m}
            role="tab"
            size="sm"
            variant={m === method ? 'default' : 'ghost'}
            aria-selected={m === method}
            onClick={() => setMethod(m)}
          >
            {m}
          </Button>
        ))}
      </div>
      <div role="tabpanel" aria-label={method} className="space-y-3">
        {method === 'One-liner' ? <InstallCommand command={created.installCommand} /> : null}
        {method === 'Ansible' ? (
          <>
            <Snippet label="1. Get the role" text={ansible.getRole} />
            <Snippet label="2. Add to Ansible Vault" text={ansible.vault} />
            <Snippet label="3. Playbook" text={ansible.playbook} />
            <p className="text-xs text-muted-foreground">
              Re-running the playbook leaves enrolled servers as they are.
            </p>
          </>
        ) : null}
        {method === 'cloud-init' ? (
          <>
            <Snippet label="User data for new servers" text={cloudInitSnippet(created.install)} />
            <p className="text-xs text-muted-foreground">
              Servers enroll on first boot, so the token must not expire before they are created.
            </p>
          </>
        ) : null}
        {method === 'Docker' ? (
          <>
            <Snippet label="On the Docker host" text={composeSnippet(created.install)} />
            <p className="text-xs text-muted-foreground">
              The container reads /proc, /sys, and / read-only; the Docker socket is not mounted.
            </p>
          </>
        ) : null}
        {method === 'One-liner' ? null : (
          <p className="text-xs text-muted-foreground">
            Shown once; these contain a secret enrollment token.
          </p>
        )}
      </div>
    </div>
  );
}

const EXPIRY = [
  { minutes: 60, label: '1 hour' },
  { minutes: 360, label: '6 hours' },
  { minutes: 1440, label: '24 hours' },
];

const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

/**
 * "Add server" (UC-03-01): pick an environment and fleet size, get a one-time install
 * command, then watch servers connect. Closing the dialog forgets the command.
 * `connected` lists hostnames that enrolled after the command was created.
 */
export function AddServerDialog({
  environments,
  onCreate,
  connected,
  onOpenChange,
}: {
  environments: Array<{ id: string; name: string }>;
  onCreate: (input: EnrollmentInput) => Promise<CreatedEnrollment>;
  connected: string[];
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState('');
  const [maxUses, setMaxUses] = useState('1');
  const [expiresInMinutes, setExpiresInMinutes] = useState(60);
  const [created, setCreated] = useState<CreatedEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const change = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setCreated(null);
      setError(null);
    }
    onOpenChange?.(next);
  };

  const submit = async () => {
    const uses = Number.parseInt(maxUses, 10);
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000) {
      setError('Enter between 1 and 1000 servers');
      return;
    }
    setError(null);
    setPending(true);
    try {
      setCreated(
        await onCreate({
          environmentId: environmentId || environments[0]!.id,
          maxUses: uses,
          expiresInMinutes,
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button>Add server</Button>
      </DialogTrigger>
      <DialogContent aria-describedby="add-server-description">
        <DialogTitle>Add server</DialogTitle>
        <DialogDescription id="add-server-description">
          The agent connects outbound over HTTPS; no inbound ports are opened on your server.
        </DialogDescription>
        {environments.length === 0 ? (
          <Alert tone="info">Add an environment (for example Production) on the product page first.</Alert>
        ) : created ? (
          <div className="space-y-4">
            {isLocalControlUrl(created.installCommand) ? (
              <Alert tone="info">
                Remote servers cannot reach this control URL (it is local to this machine). To add a VPS, run
                the platform on a public domain and set AGENT_CONTROL_URL to it. For local testing run
                scripts/dev-host.sh with this token (installs a test server with metrics).
              </Alert>
            ) : null}
            <InstallMethods created={created} />
            <p className="text-xs text-muted-foreground">
              Works for {created.maxUses} server{created.maxUses === 1 ? '' : 's'} until{' '}
              {new Date(created.expiresAt).toLocaleString()}.
            </p>
            {connected.length ? (
              <ul className="space-y-1">
                {connected.map((h) => (
                  <li key={h} className="text-sm font-medium text-success">
                    Connected: {h}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="animate-pulse text-sm text-muted-foreground">Waiting for servers to connect…</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {error ? <Alert>{error}</Alert> : null}
            <Field id="enroll-environment" label="Environment">
              <select
                id="enroll-environment"
                className={selectClass}
                value={environmentId || environments[0]!.id}
                onChange={(e) => setEnvironmentId(e.target.value)}
              >
                {environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="enroll-max-uses"
              label="How many servers?"
              hint="One command can enroll a whole fleet."
            >
              <Input
                id="enroll-max-uses"
                inputMode="numeric"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
            </Field>
            <Field id="enroll-expiry" label="Command expires in">
              <select
                id="enroll-expiry"
                className={selectClass}
                value={expiresInMinutes}
                onChange={(e) => setExpiresInMinutes(Number(e.target.value))}
              >
                {EXPIRY.map((o) => (
                  <option key={o.minutes} value={o.minutes}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Button className="w-full" disabled={pending} onClick={submit}>
              {pending ? 'Creating…' : 'Create install command'}
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
