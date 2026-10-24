'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** A copyable block of commands or configuration. */
export function Snippet({
  label,
  text,
  copyLabel = 'Copy',
}: {
  label: string;
  text: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : copyLabel}
        </Button>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-3 font-mono text-xs">
        {text}
      </pre>
    </div>
  );
}

/** The one-time install command; the token inside it is never shown again. */
export function InstallCommand({ command }: { command: string }) {
  return (
    <div className="space-y-2">
      <Snippet label="Run this on each server as root:" text={command} copyLabel="Copy command" />
      <p className="text-xs text-muted-foreground">
        Shown once. Copy it now; it contains a secret enrollment token.
      </p>
    </div>
  );
}
