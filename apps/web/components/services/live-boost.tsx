'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';

/** Starts a live boost (5 s for 10 minutes) or shows the one running (M10.7, BR-11-08). */
export function LiveBoostControl({
  name,
  until,
  now = new Date(),
  onStart,
}: {
  name: string;
  until: string | null;
  now?: Date;
  onStart: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const left = until ? Math.max(0, Math.ceil((Date.parse(until) - now.getTime()) / 60_000)) : 0;
  if (until && left > 0)
    return (
      <p role="status" className="text-xs text-success">
        Live: every 5 s, {left} min left
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        aria-label={`Live (5 s) for ${name}`}
        disabled={pending}
        onClick={async () => {
          setError(null);
          setPending(true);
          try {
            await onStart();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setPending(false);
          }
        }}
      >
        Live (5 s)
      </Button>
      {error ? <Alert className="py-1 text-xs">{error}</Alert> : null}
    </div>
  );
}
