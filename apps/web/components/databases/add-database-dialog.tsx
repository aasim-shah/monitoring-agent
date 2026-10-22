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

type Engine = 'postgres' | 'mysql' | 'mongodb';

const ENGINES: Record<Engine, { label: string; port: number; setup: (db: string) => string }> = {
  postgres: {
    label: 'PostgreSQL',
    port: 5432,
    setup: (db) => `CREATE ROLE pcp_monitor LOGIN PASSWORD '<choose a password>';
GRANT CONNECT ON DATABASE ${db || '<database>'} TO pcp_monitor;
GRANT USAGE ON SCHEMA public TO pcp_monitor;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pcp_monitor;
GRANT pg_monitor TO pcp_monitor;`,
  },
  mysql: {
    label: 'MySQL',
    port: 3306,
    setup: () => `CREATE USER 'pcp_monitor'@'%' IDENTIFIED BY '<choose a password>';
GRANT SELECT, PROCESS, REPLICATION CLIENT ON *.* TO 'pcp_monitor'@'%';`,
  },
  mongodb: {
    label: 'MongoDB',
    port: 27017,
    setup: (db) => `db.getSiblingDB('admin').createUser({
  user: 'pcp_monitor', pwd: '<choose a password>',
  roles: [{ role: 'read', db: '${db || '<database>'}' }, { role: 'clusterMonitor', db: 'admin' }]
})`,
  },
};

export interface NewDatabase {
  provider: Engine;
  displayName: string;
  executionLocation: 'private';
  config: Record<string, unknown>;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

/**
 * Add a private database (WB-07 UC-07-02). The dashboard never asks for the password:
 * the admin creates a read-only user and stores its credentials in a secret file on the
 * worker's server; the control plane keeps only the file's name (BR-07-01).
 */
export function AddDatabaseDialog({
  workers,
  onSubmit,
}: {
  workers: Array<{ id: string; hostname: string; status: string }>;
  onSubmit: (input: NewDatabase) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [engine, setEngine] = useState<Engine>('postgres');
  const [name, setName] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(ENGINES.postgres.port));
  const [database, setDatabase] = useState('');
  const [tls, setTls] = useState(true);
  const [plaintextOk, setPlaintextOk] = useState(false);
  const [secretRef, setSecretRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const ref = secretRef ?? `${engine}-${slug(name) || 'db'}`;
  const spec = ENGINES[engine];

  const reset = () => {
    setName('');
    setHost('');
    setDatabase('');
    setSecretRef(null);
    setTls(true);
    setPlaintextOk(false);
    setError(null);
  };

  const submit = async () => {
    const p = Number(port);
    if (!name.trim() || !host.trim()) return setError('Name and host are required');
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setError('Port must be 1-65535');
    if (engine === 'mongodb' && !database.trim()) return setError('Database is required for MongoDB');
    if (!tls && !plaintextOk)
      return setError('Confirm plaintext: without TLS the password crosses your network unencrypted.');
    setError(null);
    setPending(true);
    try {
      await onSubmit({
        provider: engine,
        displayName: name.trim(),
        executionLocation: 'private',
        config: {
          workerAgentId: workerId || workers[0]!.id,
          secretRef: ref,
          host: host.trim(),
          port: p,
          ...(database.trim() ? { database: database.trim() } : {}),
          tls,
          ...(!tls ? { allowInsecure: true } : {}),
        },
      });
      setOpen(false);
      reset();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>Add database</Button>
      </DialogTrigger>
      <DialogContent aria-describedby="add-db-description" className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>Add database</DialogTitle>
        <DialogDescription id="add-db-description">
          The private worker connects from inside your network with a read-only user. Its password stays on
          that server.
        </DialogDescription>
        {workers.length === 0 ? (
          <Alert tone="info">Add a private worker first (above); it runs next to your databases.</Alert>
        ) : (
          <div className="space-y-4">
            {error ? <Alert>{error}</Alert> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="db-engine" label="Engine">
                <select
                  id="db-engine"
                  className={selectClass}
                  value={engine}
                  onChange={(e) => {
                    const next = e.target.value as Engine;
                    setEngine(next);
                    setPort(String(ENGINES[next].port));
                  }}
                >
                  {(Object.keys(ENGINES) as Engine[]).map((k) => (
                    <option key={k} value={k}>
                      {ENGINES[k].label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="db-name" label="Name">
                <Input
                  id="db-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Orders DB"
                />
              </Field>
              <Field id="db-worker" label="Private worker">
                <select
                  id="db-worker"
                  className={selectClass}
                  value={workerId || workers[0]!.id}
                  onChange={(e) => setWorkerId(e.target.value)}
                >
                  {workers.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.hostname}
                      {w.status !== 'active' ? ` (${w.status})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="db-host" label="Host" hint="As the worker sees it, e.g. 10.0.0.5 or db.internal">
                <Input id="db-host" value={host} onChange={(e) => setHost(e.target.value)} />
              </Field>
              <Field id="db-port" label="Port">
                <Input
                  id="db-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </Field>
              <Field id="db-database" label="Database">
                <Input id="db-database" value={database} onChange={(e) => setDatabase(e.target.value)} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={tls}
                onChange={(e) => setTls(e.target.checked)}
                aria-label="Use TLS"
              />
              Use TLS
            </label>
            {!tls ? (
              <label className="flex items-start gap-2 text-sm text-destructive">
                <input
                  type="checkbox"
                  checked={plaintextOk}
                  onChange={(e) => setPlaintextOk(e.target.checked)}
                />
                Allow plaintext on this private network (recorded in the audit log)
              </label>
            ) : null}
            <div className="space-y-2">
              <p className="text-sm font-medium">1. Create a read-only user</p>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs">
                {spec.setup(database)}
              </pre>
            </div>
            <Field id="db-secret" label="Secret name" hint="Letters, digits, . _ - only">
              <Input id="db-secret" value={ref} onChange={(e) => setSecretRef(e.target.value)} />
            </Field>
            <div className="space-y-2">
              <p className="text-sm font-medium">2. Put its credentials on the worker&apos;s server</p>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs">{`# /etc/pcp-worker/secrets/${ref}.yaml  (chmod 600)
username: pcp_monitor
password: <the password you chose>`}</pre>
            </div>
            <Button className="w-full" disabled={pending} onClick={submit}>
              {pending ? 'Saving…' : 'Save and validate'}
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
