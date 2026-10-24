'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';

/**
 * Level 1 managed exporter (M18.3, spec §8.9): proposes `host.install_exporter`; after approval
 * pcp-helper installs the pinned exporter on 127.0.0.1 and the agent starts scraping it.
 */
export function ManagedExporterButton({
  exporter,
  propose,
}: {
  exporter: 'redis_exporter' | 'kafka_exporter';
  propose: (exporter: string) => Promise<{ status: string; reason?: string | null }>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <span className="inline-flex flex-col">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setMessage(null);
          try {
            const r = await propose(exporter);
            setMessage(
              r.status === 'pending_approval'
                ? 'Proposed: it waits for approval in Actions.'
                : r.status === 'rejected_policy'
                  ? (r.reason ?? 'Refused by policy')
                  : `Action ${r.status.replaceAll('_', ' ')}.`,
            );
          } catch (e) {
            setMessage(errorMessage(e));
          } finally {
            setPending(false);
          }
        }}
      >
        {`Install ${exporter} (Level 1)`}
      </Button>
      {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
    </span>
  );
}
