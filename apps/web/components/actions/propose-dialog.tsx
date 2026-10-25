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

export interface HostOption {
  agentId: string;
  hostname: string;
  environmentId: string;
}

export interface NewProposal {
  agentId: string;
  environmentId: string;
  unit: string;
  reason: string;
}

const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

/** Propose a service restart (UC-16-02); only units the environment's policy allows are offered. */
export function ProposeDialog({
  hosts,
  unitsByEnvironment,
  onSubmit,
}: {
  hosts: HostOption[];
  unitsByEnvironment: Record<string, string[]>;
  onSubmit: (p: NewProposal) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState(hosts[0]?.agentId ?? '');
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const host = hosts.find((h) => h.agentId === agentId);
  const units = host ? (unitsByEnvironment[host.environmentId] ?? []) : [];

  const submit = async () => {
    if (!host) return setError('Choose a host');
    if (!unit || !units.includes(unit)) return setError('Choose a service');
    if (!reason.trim()) return setError('Say why');
    setError(null);
    setPending(true);
    try {
      await onSubmit({
        agentId: host.agentId,
        environmentId: host.environmentId,
        unit,
        reason: reason.trim(),
      });
      setOpen(false);
      setUnit('');
      setReason('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Propose restart</Button>
      </DialogTrigger>
      <DialogContent aria-describedby="propose-description">
        <DialogTitle>Propose a service restart</DialogTitle>
        <DialogDescription id="propose-description">
          An approver reviews the impact first. The host restarts the service only if its own helper allowlist
          lists it.
        </DialogDescription>
        <div className="portal-feature-section space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <Field id="propose-host" label="Host">
            <select
              id="propose-host"
              className={selectClass}
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setUnit('');
              }}
            >
              {hosts.map((h) => (
                <option key={h.agentId} value={h.agentId}>
                  {h.hostname}
                </option>
              ))}
            </select>
          </Field>
          {units.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No units are enabled for this environment; edit its policy first.
            </p>
          ) : (
            <Field id="propose-unit" label="Service">
              <select
                id="propose-unit"
                className={selectClass}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              >
                <option value="">Choose…</option>
                {units.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field id="propose-reason" label="Reason">
            <Input id="propose-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button className="w-full" disabled={pending || units.length === 0} onClick={submit}>
            {pending ? 'Sending…' : 'Send for approval'}
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
