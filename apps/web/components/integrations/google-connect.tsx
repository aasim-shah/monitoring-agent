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
import { errorMessage } from '@/lib/api';
import { GOOGLE_SCOPE_PURPOSES } from '@/lib/google';

/** Explains each requested scope, then sends the member to Google's consent screen (WB-08 UC-08-01). */
export function GoogleConnectDialog({ onConnect }: { onConnect: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm">Connect Google</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>Connect Google</DialogTitle>
        <DialogDescription>
          One read-only grant for GA4, Search Console, Firebase, and Play vitals. You can untick anything on
          Google&apos;s screen; those services then show as not granted.
        </DialogDescription>
        <ul aria-label="Google access requested" className="list-disc space-y-0.5 pl-5 text-xs">
          {GOOGLE_SCOPE_PURPOSES.map(([scope, purpose]) => (
            <li key={scope}>{purpose}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Access is tied to the Google account you choose. Use a shared operations account so it keeps working
          when people leave. Daily values sync every hour; nothing is ever changed in Google.
        </p>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            disabled={pending}
            onClick={async () => {
              setError(null);
              setPending(true);
              try {
                await onConnect();
              } catch (e) {
                setError(errorMessage(e));
                setPending(false);
              }
            }}
          >
            {pending ? 'Opening Google…' : 'Continue to Google'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
