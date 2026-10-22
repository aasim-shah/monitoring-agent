'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { unwrap } from '@pcp/api-client';
import type { Role } from '@pcp/shared-contracts';
import { api, errorMessage } from '@/lib/api';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Input } from '../ui/input';
import { RoleSelect } from './role-select';

export function InviteForm({
  orgId,
  actorRole,
  products,
}: {
  orgId: string;
  actorRole: Role;
  products: { id: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [scope, setScope] = useState<string[] | 'all'>('all');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setResult(null);
    try {
      unwrap(
        await api.POST('/api/v1/organizations/{orgId}/invitations', {
          params: { path: { orgId } },
          body: { email, role, ...(scope === 'all' ? {} : { productIds: scope }) },
        }),
      );
      setResult({ ok: true, message: `Invitation sent to ${email}.` });
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['audit', orgId] });
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {result ? <Alert tone={result.ok ? 'success' : 'error'}>{result.message}</Alert> : null}
      <Field id="invite-email" label="Email">
        <Input
          id="invite-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field id="invite-role" label="Role">
        <RoleSelect id="invite-role" actorRole={actorRole} value={role} onChange={setRole} />
      </Field>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">Products</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={scope === 'all'}
            onChange={(e) => setScope(e.target.checked ? 'all' : [])}
          />
          All products
        </label>
        {scope !== 'all'
          ? products.map((p) => (
              <label key={p.id} className="flex items-center gap-2 pl-5 text-sm">
                <input
                  type="checkbox"
                  checked={scope.includes(p.id)}
                  onChange={(e) =>
                    setScope(e.target.checked ? [...scope, p.id] : scope.filter((id) => id !== p.id))
                  }
                />
                {p.name}
              </label>
            ))
          : null}
      </fieldset>
      <Button type="submit" disabled={pending || !email}>
        {pending ? 'Sending…' : 'Send invitation'}
      </Button>
    </form>
  );
}
