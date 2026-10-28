'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  GOOGLE_SCOPES,
  SERVICE_ACCOUNT_STEPS,
  STATUS_LABEL,
  isServiceAccountEmail,
  serviceStatuses,
} from '@/lib/google';
import { ServiceAccountUpload } from './google-service-account';

/** Who granted access and what each Google service can read (WB-08 UC-08-02, BR-08-03, BR-08-07). */
export function GoogleAccess({
  accountEmail,
  grantedScopes,
  canConfigure,
  onGrant,
  onUploadKey,
  onCheckKey,
}: {
  accountEmail: string | null;
  grantedScopes: string[];
  canConfigure: boolean;
  /** Starts a consent that asks only for what is missing. */
  onGrant: () => Promise<void>;
  /** Replaces the connection's access with an uploaded service account key. */
  onUploadKey: (key: string) => Promise<void>;
  /** Probes again what the stored service account can read. */
  onCheckKey: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const serviceAccount = isServiceAccountEmail(accountEmail);
  const rows = serviceStatuses(grantedScopes, serviceAccount);
  const missing = GOOGLE_SCOPES.some((s) => !grantedScopes.includes(s));
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setPending(true);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      aria-label="Google access"
      className="portal-detail-card space-y-4 rounded-lg border border-border bg-card p-6"
    >
      <h2 className="text-sm font-semibold">Google access</h2>
      <p className="text-sm">
        {serviceAccount
          ? `Connected with service account ${accountEmail}`
          : accountEmail
            ? `Connected as ${accountEmail}`
            : 'Not connected to a Google account yet'}
      </p>
      {serviceAccount ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            A service account reads only what it was added to. Add this email in each Google product, then
            check access again.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await navigator.clipboard?.writeText(accountEmail!);
              setCopied(true);
            }}
          >
            {copied ? 'Email copied' : 'Copy service account email'}
          </Button>
          <ul aria-label="Where to add the service account" className="list-disc space-y-0.5 pl-5 text-xs">
            {SERVICE_ACCOUNT_STEPS.map(([service, where]) => (
              <li key={service}>
                <span className="font-medium">{service}:</span> {where}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Access is tied to this Google account. Use a shared operations account so it keeps working when
          people leave.
        </p>
      )}
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
      {canConfigure ? (
        <div className="flex flex-wrap items-start gap-2">
          {serviceAccount ? (
            <Button size="sm" disabled={pending} onClick={() => run(onCheckKey)}>
              {pending ? 'Checking…' : 'Check access again'}
            </Button>
          ) : missing ? (
            <Button size="sm" disabled={pending} onClick={() => run(onGrant)}>
              Grant access
            </Button>
          ) : null}
          <ServiceAccountUpload
            label={serviceAccount ? 'Replace JSON key' : 'Use a service account key instead'}
            onUpload={onUploadKey}
          />
        </div>
      ) : null}
    </section>
  );
}
