'use client';

import { useState } from 'react';
import { errorMessage } from '@/lib/api';

/** Retained logs opt-in for one pack (M18.1): redacted on the server, kept 7 days. */
export function RetainLogsToggle({
  name,
  enabled,
  onChange,
}: {
  name: string;
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <label className="inline-flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={async (e) => {
            setError(null);
            setPending(true);
            try {
              await onChange(e.target.checked);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setPending(false);
            }
          }}
        />
        {`Keep ${name} logs for 7 days (redacted)`}
      </label>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
