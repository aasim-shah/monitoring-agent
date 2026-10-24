'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
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

export interface ExportRow {
  id: string;
  status: string;
  sizeBytes: number | null;
  error: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
const size = (b: number | null) =>
  b === null ? '' : b < 1024 * 1024 ? `${Math.ceil(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`;

/** Owner-only data export (WB-17 UC-17-09): a JSON archive without secrets, downloadable for 24 h. */
export function ExportCard({
  exports,
  downloadHref,
  onExport,
}: {
  exports: ExportRow[];
  downloadHref: (id: string) => string;
  onExport: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Card className="space-y-3 p-4">
      <CardTitle className="text-base">Export data</CardTitle>
      <CardDescription>
        A JSON archive of this organization: products, assets, connections, incidents, reports, members, and
        the audit log. It has no passwords, tokens, or other credentials. The download link works for 24
        hours.
      </CardDescription>
      {error ? <Alert>{error}</Alert> : null}
      <Button
        size="sm"
        disabled={pending}
        onClick={async () => {
          setError(null);
          setPending(true);
          try {
            await onExport();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setPending(false);
          }
        }}
      >
        Export data
      </Button>
      {exports.length ? (
        <ul className="space-y-1 text-sm">
          {exports.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>Requested {day(e.createdAt)}</span>
              {e.status === 'ready' ? (
                <a className="underline" href={downloadHref(e.id)}>
                  Download ({size(e.sizeBytes)}, until {day(e.expiresAt!)})
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {e.status === 'queued'
                    ? 'Being prepared…'
                    : e.status === 'failed'
                      ? `Failed: ${e.error ?? ''}`
                      : 'Link expired'}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/** Owner-only deletion with the name typed back; recoverable for 30 days. */
export function DeleteOrganization({
  name,
  onDelete,
}: {
  name: string;
  onDelete: (confirmName: string) => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Card className="space-y-3 border-destructive/40 p-4">
      <CardTitle className="text-base">Delete organization</CardTitle>
      <CardDescription>
        Members lose access at once, agents stop sending data, and connections are disconnected. Everything is
        removed for good after 30 days; until then an owner can cancel.
      </CardDescription>
      <Dialog>
        <DialogTrigger asChild>
          <Button size="sm" variant="destructive">
            Delete organization
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            After 30 days all data is purged: products, assets, metrics, incidents, reports, and the audit
            log. Export the data first if you need it. Agents and connections are revoked now and must be set
            up again if you cancel.
          </DialogDescription>
          <Field id="confirm-org-name" label="Type the organization name to confirm">
            <Input
              id="confirm-org-name"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Keep it</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={typed !== name || pending}
              onClick={async () => {
                setError(null);
                setPending(true);
                try {
                  await onDelete(typed);
                } catch (e) {
                  setError(errorMessage(e));
                  setPending(false);
                }
              }}
            >
              Delete {name}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function DeletionBanner({
  scheduledFor,
  canCancel,
  onCancel,
}: {
  scheduledFor: string;
  canCancel: boolean;
  onCancel: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Alert className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <span>
        This organization is scheduled for deletion on {day(scheduledFor)}. Members cannot sign in to it until
        then.
      </span>
      {canCancel ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              await onCancel();
            } finally {
              setPending(false);
            }
          }}
        >
          Cancel deletion
        </Button>
      ) : null}
    </Alert>
  );
}
