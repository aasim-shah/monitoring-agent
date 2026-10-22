'use client';

import { useState } from 'react';
import { AgentStatusBadge } from '@/components/agents/agent-status-badge';
import { InstallCommand } from '@/components/agents/install-command';
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
import { errorMessage } from '@/lib/api';

export interface WorkerSummary {
  id: string;
  hostname: string;
  status: 'active' | 'degraded' | 'revoked';
  stale: boolean;
}

const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

/** Private workers (UC-07-01): one container inside the customer network reaches private databases. */
export function WorkerPanel({
  workers,
  environments,
  canEnroll,
  onCreate,
}: {
  workers: WorkerSummary[];
  environments: Array<{ id: string; name: string }>;
  canEnroll: boolean;
  onCreate: (environmentId: string) => Promise<{ installCommand: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState('');
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Private workers</h2>
          <p className="text-xs text-muted-foreground">
            Runs next to your databases and connects out to the platform; credentials never leave that server.
          </p>
        </div>
        {canEnroll ? (
          <Dialog
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) {
                setCommand(null);
                setError(null);
              }
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                Add private worker
              </Button>
            </DialogTrigger>
            <DialogContent aria-describedby="add-worker-description">
              <DialogTitle>Add private worker</DialogTitle>
              <DialogDescription id="add-worker-description">
                Run this on a server that can reach your databases (Docker required). No inbound ports are
                opened.
              </DialogDescription>
              {error ? <Alert>{error}</Alert> : null}
              {command ? (
                <div className="space-y-3">
                  <InstallCommand command={command} />
                  <p className="text-xs text-muted-foreground">
                    Then put each database&apos;s credentials in{' '}
                    <code>/etc/pcp-worker/secrets/&lt;name&gt;.yaml</code> on that server.
                  </p>
                </div>
              ) : environments.length === 0 ? (
                <Alert tone="info">
                  Add an environment (for example Production) on the product page first.
                </Alert>
              ) : (
                <div className="space-y-3">
                  <Field id="worker-env" label="Environment">
                    <select
                      id="worker-env"
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
                  <Button
                    className="w-full"
                    onClick={async () => {
                      try {
                        setCommand((await onCreate(environmentId || environments[0]!.id)).installCommand);
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }}
                  >
                    Create install command
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
        ) : null}
      </div>
      {workers.length ? (
        <ul className="flex flex-wrap gap-3">
          {workers.map((w) => (
            <li key={w.id} className="flex items-center gap-2 text-sm">
              <span className="font-medium">{w.hostname}</span>
              <AgentStatusBadge status={w.status} stale={w.stale} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No private worker yet.</p>
      )}
    </div>
  );
}
