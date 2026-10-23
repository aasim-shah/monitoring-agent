'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';

export interface PolicyRow {
  environmentId: string;
  environmentName: string;
  production: boolean;
  capability: string;
  label: string;
  enabled: boolean;
  approverRoles: string[];
  requireApproval: boolean;
  settings: { units?: string[] };
  available: boolean;
}

export type ApproverRole = 'owner' | 'admin' | 'operator';

export interface PolicyInput {
  environmentId: string;
  enabled: boolean;
  approverRoles: ApproverRole[];
  requireApproval: boolean;
  settings: { units: string[] };
}

const UNIT = /^[A-Za-z0-9@._-]+\.service$/;
const ROLES = ['owner', 'admin', 'operator'] as const;
const PROVIDER: Record<string, string> = {
  'cloudflare.purge_cache': 'Cloudflare',
  'github.workflow_dispatch': 'GitHub',
};

function PolicyDialog({
  policy,
  onClose,
  onSave,
}: {
  policy: PolicyRow;
  onClose: () => void;
  onSave: (capability: string, input: PolicyInput) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [roles, setRoles] = useState<ApproverRole[]>(policy.approverRoles as ApproverRole[]);
  const [requireApproval, setRequireApproval] = useState(policy.requireApproval);
  const [units, setUnits] = useState((policy.settings.units ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const save = async () => {
    const list = units
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    const bad = list.find((u) => !UNIT.test(u));
    if (bad) return setError(`${bad} is not a systemd service name such as api.service`);
    if (enabled && list.length === 0) return setError('List at least one unit');
    if (roles.length === 0) return setError('Choose at least one approver role');
    setError(null);
    setPending(true);
    try {
      await onSave(policy.capability, {
        environmentId: policy.environmentId,
        enabled,
        approverRoles: roles,
        requireApproval: policy.production ? true : requireApproval,
        settings: { units: list },
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent aria-describedby="policy-description">
        <DialogTitle>{`${policy.label} · ${policy.environmentName}`}</DialogTitle>
        <DialogDescription id="policy-description">
          Only these units can be restarted, and only on hosts whose own helper allowlist also lists them.
        </DialogDescription>
        <div className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <Field
            id="policy-units"
            label="Units that may be restarted"
            hint="Comma-separated, e.g. api.service"
          >
            <Input id="policy-units" value={units} onChange={(e) => setUnits(e.target.value)} />
          </Field>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Approvers</legend>
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-2 text-sm capitalize">
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={(e) => setRoles((x) => (e.target.checked ? [...x, r] : x.filter((y) => y !== r)))}
                />
                {r}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!requireApproval && !policy.production}
              disabled={policy.production}
              onChange={(e) => setRequireApproval(!e.target.checked)}
            />
            Allow without approval
          </label>
          {policy.production ? (
            <p className="text-xs text-muted-foreground">
              Production always needs an approver other than the requester. AI proposals always need approval.
            </p>
          ) : null}
          <Button className="w-full" disabled={pending} onClick={save}>
            {pending ? 'Saving…' : 'Save policy'}
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

/** Action policies (UC-16-01): every capability per environment, disabled until enabled here. */
export function PolicyList({
  policies,
  canManage,
  onSave,
}: {
  policies: PolicyRow[];
  canManage: boolean;
  onSave: (capability: string, input: PolicyInput) => Promise<void>;
}) {
  const [editing, setEditing] = useState<PolicyRow | null>(null);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Action</th>
            <th className="px-4 py-2 font-medium">State</th>
            <th className="px-4 py-2 font-medium">Allowlist</th>
            <th className="px-4 py-2 font-medium">Approvers</th>
            <th className="px-4 py-2 font-medium">
              <span className="sr-only">Edit</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {policies.map((p) => (
            <tr key={`${p.environmentId}:${p.capability}`} aria-label={`${p.label} · ${p.environmentName}`}>
              <td className="px-4 py-2 font-medium">
                {p.label} <span className="text-muted-foreground">· {p.environmentName}</span>
              </td>
              <td className="px-4 py-2">
                {!p.available ? (
                  <span className="text-muted-foreground">{`Needs a ${PROVIDER[p.capability] ?? 'provider'} connection`}</span>
                ) : p.enabled ? (
                  <Badge className="border-success/40 text-success">Enabled</Badge>
                ) : (
                  <Badge>Disabled</Badge>
                )}
              </td>
              <td className="px-4 py-2 text-muted-foreground">
                {(p.settings.units ?? []).join(', ') || '—'}
              </td>
              <td className="px-4 py-2 capitalize text-muted-foreground">
                {p.approverRoles.join(', ')}
                {!p.requireApproval && !p.production ? ' (approval optional)' : ''}
              </td>
              <td className="px-4 py-2 text-right">
                {canManage && p.available ? (
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing ? <PolicyDialog policy={editing} onClose={() => setEditing(null)} onSave={onSave} /> : null}
    </div>
  );
}
