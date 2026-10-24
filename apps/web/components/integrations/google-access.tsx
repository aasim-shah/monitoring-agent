'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { GOOGLE_SCOPES, STATUS_LABEL, serviceStatuses } from '@/lib/google';

/** Who granted access and what each Google service can read (WB-08 UC-08-02, BR-08-03, BR-08-07). */
export function GoogleAccess({
  accountEmail,
  grantedScopes,
  canConfigure,
  onGrant,
}: {
  accountEmail: string | null;
  grantedScopes: string[];
  canConfigure: boolean;
  /** Starts a consent that asks only for what is missing. */
  onGrant: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const rows = serviceStatuses(grantedScopes);
  const missing = GOOGLE_SCOPES.some((s) => !grantedScopes.includes(s));
  return (
    <section aria-label="Google access" className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">Google access</h2>
      <p className="text-sm">
        {accountEmail ? `Connected as ${accountEmail}` : 'Not connected to a Google account yet'}
      </p>
      <p className="text-xs text-muted-foreground">
        Access is tied to this Google account. Use a shared operations account so it keeps working when people
        leave.
      </p>
      <table aria-label="Google services" className="w-full text-left text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border first:border-t-0">
              <th scope="row" className="py-1 font-normal">
                {r.label}
              </th>
              <td
                className={cn(
                  'py-1 text-right text-xs',
                  r.status === 'available' ? 'text-success' : 'text-muted-foreground',
                )}
              >
                {STATUS_LABEL[r.status]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <Alert>{error}</Alert> : null}
      {canConfigure && missing ? (
        <Button
          size="sm"
          disabled={pending}
          onClick={async () => {
            setError(null);
            setPending(true);
            try {
              await onGrant();
            } catch (e) {
              setError(errorMessage(e));
              setPending(false);
            }
          }}
        >
          Grant access
        </Button>
      ) : null}
    </section>
  );
}
