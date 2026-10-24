'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { errorMessage } from '@/lib/api';

export interface Guide {
  summary: string;
  steps: Array<{ text: string; command?: string }>;
  proof: string;
  proofLabel: string;
  troubleshooting: string[];
}

export interface Verification {
  status: 'active' | 'not_found';
  series: number;
}

/** How long to wait for the proof metric before showing the troubleshooting checklist. */
const PATIENCE_MS = 15 * 60_000;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

/**
 * Level 2 guided setup (spec §8.9, WB-11 UC-11-04): the exact commands for the customer's own change and
 * a live check for the metric that proves it works. The platform never runs these (BR-11-04).
 */
export function GuidedSetup({
  name,
  guide,
  verify,
  now = Date.now,
}: {
  name: string;
  guide: Guide;
  verify: () => Promise<Verification>;
  now?: () => number;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openedAt = useRef<number | null>(null);

  const check = useCallback(async () => {
    setError(null);
    try {
      setResult(await verify());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [verify]);

  useEffect(() => {
    if (!open) return;
    openedAt.current ??= now();
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => clearInterval(timer);
  }, [open, check, now]);

  const active = result?.status === 'active';
  const patienceOver = openedAt.current !== null && now() - openedAt.current >= PATIENCE_MS;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" aria-label={`Deep metrics for ${name}`}>
          Deep metrics
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>Deep metrics for {name}</DialogTitle>
        <DialogDescription>{guide.summary}</DialogDescription>
        <p className="text-xs text-muted-foreground">
          You make these changes; the platform never runs them. Nothing is collected beyond what the guide
          names.
        </p>
        <ol aria-label="Setup steps" className="list-decimal space-y-3 pl-5 text-sm">
          {guide.steps.map((step, i) => (
            <li key={i} className="space-y-1">
              <p>{step.text}</p>
              {step.command ? (
                <div className="flex items-start gap-2">
                  <pre className="flex-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                    <code>{step.command}</code>
                  </pre>
                  <CopyButton text={step.command} label={`Copy command ${i + 1}`} />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        <section aria-label="Verification" className="space-y-2 rounded-md border border-border p-3">
          {active ? (
            <p role="status" className="text-sm font-medium text-success">
              Deep metrics active
            </p>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Waiting for {guide.proofLabel} from this host… (checked every 15 s)
            </p>
          )}
          {error ? <Alert>{error}</Alert> : null}
          {!active && patienceOver ? (
            <>
              <p className="text-sm">Not found after 15 minutes. Check:</p>
              <ul aria-label="Troubleshooting" className="list-disc space-y-0.5 pl-5 text-xs">
                {guide.troubleshooting.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </>
          ) : null}
          {!active ? (
            <Button size="sm" variant="outline" onClick={() => void check()}>
              Check now
            </Button>
          ) : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}
