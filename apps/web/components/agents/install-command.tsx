'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** The one-time install command; the token inside it is never shown again. */
export function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Run this on each server as root:</p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-3 font-mono text-xs">
        {command}
      </pre>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Shown once. Copy it now; it contains a secret enrollment token.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(command);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy command'}
        </Button>
      </div>
    </div>
  );
}
