'use client';

import type { Role } from '@pcp/shared-contracts';
import { ROLE_LABELS, rolesAtOrBelow } from '@/lib/roles';

export function RoleSelect({
  id,
  actorRole,
  value,
  onChange,
  disabled,
}: {
  id: string;
  actorRole: Role;
  value: Role;
  onChange: (role: Role) => void;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Role)}
      className="h-8 rounded-md border border-border bg-background px-2 text-sm"
    >
      {rolesAtOrBelow(actorRole).map((r) => (
        <option key={r} value={r}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </select>
  );
}
