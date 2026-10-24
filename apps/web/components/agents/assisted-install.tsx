'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import { Snippet } from './install-command';

export interface InstallHostView {
  id: string;
  host: string;
  port: number;
  username: string;
  fingerprint: string | null;
  fingerprintConfirmedAt: string | null;
  status: string;
  output: string;
  scriptVersion: string | null;
  cleanup: string | null;
  error: string | null;
}

export interface InstallSessionView {
  id: string;
  mode: 'key' | 'password';
  status: string;
  expiresAt: string;
  publicKey?: string | null;
  setupCommand?: string | null;
  egressIps: string[];
  hosts: InstallHostView[];
}

export interface AssistedInstallApi {
  create(
    environmentId: string,
    body: { mode: 'key' | 'password'; hosts: Array<{ host: string; port: number; username?: string }> },
  ): Promise<InstallSessionView>;
  connect(id: string, password?: string): Promise<void>;
  confirm(id: string, hostId: string, fingerprint: string): Promise<void>;
  get(id: string): Promise<InstallSessionView>;
  abort(id: string): Promise<void>;
}

const ACTIVE = ['connecting', 'awaiting_confirmation', 'installing'];
const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

/** "host" or "host:port", one per line. IPv6 needs brackets for a port: [2001:db8::1]:2222. */
function parseHosts(text: string): Array<{ host: string; port: number }> {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const v6 = /^\[(.+)\](?::(\d+))?$/.exec(l);
      if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : 22 };
      const m = /^([^:\s]+)(?::(\d+))?$/.exec(l);
      return m ? { host: m[1]!, port: m[2] ? Number(m[2]) : 22 } : { host: l, port: 22 };
    });
}

function HostCard({
  host,
  onConfirm,
  mode,
}: {
  host: InstallHostView;
  onConfirm: (h: InstallHostView) => void;
  mode: 'key' | 'password';
}) {
  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {host.host}:{host.port}
        </p>
        <span className="text-xs text-muted-foreground">{host.status.replaceAll('_', ' ')}</span>
      </div>
      {host.status === 'awaiting_confirmation' && host.fingerprint ? (
        <div className="space-y-2">
          <p className="text-xs">
            Host-key fingerprint. Compare it with{' '}
            <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the server before you confirm:
          </p>
          <p className="break-all rounded bg-muted p-2 font-mono text-xs">{host.fingerprint}</p>
          <Button size="sm" onClick={() => onConfirm(host)}>
            {`Fingerprint matches, install on ${host.host}`}
          </Button>
        </div>
      ) : null}
      {host.output ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">
          {host.output}
        </pre>
      ) : null}
      {host.error ? <Alert>{host.error}</Alert> : null}
      {host.status === 'installed' && host.cleanup === 'done' ? (
        <p className="text-xs text-success">
          Installed. The pcp-install user and the session key were removed.
        </p>
      ) : null}
      {host.status === 'installed' && mode === 'password' ? (
        <Alert tone="info">Installed. Rotate the password you entered; the platform did not keep it.</Alert>
      ) : null}
    </li>
  );
}

/**
 * Assisted SSH install (UC-05-05/06): the platform connects from its published IPs with a one-time
 * key (or, as a last resort, a password used once), shows each host-key fingerprint for the admin
 * to confirm, runs only the install script, then removes its access.
 */
export function AssistedInstallDialog({
  environments,
  api,
  pollMs = 2000,
}: {
  environments: Array<{ id: string; name: string }>;
  api: AssistedInstallApi;
  pollMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState('');
  const [mode, setMode] = useState<'key' | 'password'>('key');
  const [hostsText, setHostsText] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<InstallSessionView | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      setSession(await api.get(session.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api, session]);

  const active = session !== null && connected && ACTIVE.includes(session.status);
  useEffect(() => {
    if (!active || pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [active, pollMs, refresh]);

  const act = async (f: () => Promise<void>) => {
    setError(null);
    setPending(true);
    try {
      await f();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  const start = () =>
    act(async () => {
      const hosts = parseHosts(hostsText);
      if (!hosts.length) throw new Error('Enter at least one server');
      setSession(
        await api.create(environmentId || environments[0]!.id, {
          mode,
          hosts: mode === 'password' ? hosts.map((h) => ({ ...h, username })) : hosts,
        }),
      );
    });

  const connect = () =>
    act(async () => {
      const s = session!;
      const pw = s.mode === 'password' ? password : undefined;
      setPassword('');
      await api.connect(s.id, pw);
      setConnected(true);
      setSession(await api.get(s.id));
    });

  const confirm = (h: InstallHostView) =>
    act(async () => {
      await api.confirm(session!.id, h.id, h.fingerprint!);
      setSession(await api.get(session!.id));
    });

  const end = () =>
    act(async () => {
      await api.abort(session!.id);
      setSession(null);
      setConnected(false);
    });

  const change = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSession(null);
      setConnected(false);
      setPassword('');
      setError(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button variant="outline">Assisted install</Button>
      </DialogTrigger>
      <DialogContent aria-describedby="assisted-install-description" className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>Assisted install</DialogTitle>
        <DialogDescription id="assisted-install-description">
          The platform connects to your servers over SSH once, installs the agent with the standard script,
          and removes its access. It never keeps a key or password.
        </DialogDescription>
        {error ? <Alert>{error}</Alert> : null}
        {environments.length === 0 ? (
          <Alert tone="info">Add an environment (for example Production) on the product page first.</Alert>
        ) : !session ? (
          <div className="space-y-4">
            <Field id="assisted-environment" label="Environment">
              <select
                id="assisted-environment"
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
            <fieldset className="space-y-1 text-sm">
              <legend className="font-medium">How the platform logs in</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="assisted-mode"
                  checked={mode === 'key'}
                  onChange={() => setMode('key')}
                />
                One-time key (recommended)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="assisted-mode"
                  checked={mode === 'password'}
                  onChange={() => setMode('password')}
                />
                Password (last resort)
              </label>
            </fieldset>
            <Field id="assisted-hosts" label="Servers" hint="One per line: host or host:port. At most 10.">
              <textarea
                id="assisted-hosts"
                className="min-h-24 w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
                value={hostsText}
                onChange={(e) => setHostsText(e.target.value)}
              />
            </Field>
            {mode === 'password' ? (
              <Field
                id="assisted-username"
                label="User name"
                hint="A user that can run sudo on every server."
              >
                <Input
                  id="assisted-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </Field>
            ) : null}
            <Button className="w-full" disabled={pending} onClick={start}>
              {pending ? 'Starting…' : 'Start session'}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {session.egressIps.length ? (
              <p className="text-xs text-muted-foreground">
                Allow SSH from {session.egressIps.join(', ')} for the next hour.
              </p>
            ) : null}
            {!connected && session.mode === 'key' && session.setupCommand ? (
              <>
                <Snippet
                  label="Run on each server (adds a temporary pcp-install user with this key)"
                  text={session.setupCommand}
                />
                <Button disabled={pending} onClick={connect}>
                  Key added, connect
                </Button>
              </>
            ) : null}
            {!connected && session.mode === 'password' ? (
              <>
                <Field
                  id="assisted-password"
                  label="Password"
                  hint="Used once, held in memory only, never stored."
                >
                  <Input
                    id="assisted-password"
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Button disabled={pending || !password} onClick={connect}>
                  Connect
                </Button>
              </>
            ) : null}
            {connected ? (
              <ul aria-label="Servers" className="space-y-2">
                {session.hosts.map((h) => (
                  <HostCard key={h.id} host={h} mode={session.mode} onConfirm={confirm} />
                ))}
              </ul>
            ) : null}
            <div className="flex justify-end">
              <Button variant="ghost" disabled={pending} onClick={end}>
                End session
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
