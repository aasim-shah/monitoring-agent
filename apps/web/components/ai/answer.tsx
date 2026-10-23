'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { capitalize, toolLabel } from './tool-labels';

export interface EvidenceItem {
  id: string;
  tool: string;
  status: 'ok' | 'denied' | 'error' | 'truncated';
  gaps: string[];
  sources: Array<{ label: string; href?: string }>;
  data: unknown;
}

export interface AnswerData {
  text: string;
  evidence: EvidenceItem[];
  missing: string[];
  confidence: 'high' | 'medium' | 'low' | null;
  validation: 'verified' | 'unverified' | 'partial' | null;
  problems?: string[];
}

const STATUS: Record<EvidenceItem['status'], string> = {
  ok: 'answered',
  denied: 'not available to you',
  error: 'failed',
  truncated: 'truncated to 64 KB',
};

/** An investigation answer (WB-14 §8): citations open the evidence; gaps are listed, not guessed. */
export function Answer({ data }: { data: AnswerData }) {
  const [open, setOpen] = useState<string | null>(null);
  const ids = new Set(data.evidence.map((e) => e.id));
  const selected = data.evidence.find((e) => e.id === open);
  const parts = data.text.split(/(\[E\d+\])/g);
  return (
    <div className="space-y-3">
      {data.validation === 'unverified' ? (
        <Alert>
          This answer is not verified: it contains statements that could not be matched to the evidence.
          {data.problems?.length ? ` (${data.problems.join('; ')})` : ''}
        </Alert>
      ) : data.validation === 'partial' ? (
        <Alert>The investigation is incomplete; the answer uses only the evidence gathered so far.</Alert>
      ) : null}
      <div className="whitespace-pre-wrap text-sm leading-6">
        {parts.map((p, i) => {
          const id = /^\[(E\d+)\]$/.exec(p)?.[1];
          if (!id || !ids.has(id)) return <Fragment key={i}>{p}</Fragment>;
          return (
            <button
              key={i}
              type="button"
              aria-label={`Evidence ${id}`}
              onClick={() => setOpen(open === id ? null : id)}
              className={cn(
                'mx-0.5 rounded border border-border px-1 font-mono text-xs text-primary hover:bg-muted',
                open === id && 'bg-muted',
              )}
            >
              {id}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {data.confidence ? <Badge>Confidence: {data.confidence}</Badge> : null}
        {data.validation === 'verified' ? (
          <Badge className="border-success/40 text-success">Numbers checked against the evidence</Badge>
        ) : null}
      </div>
      {selected ? (
        <section
          aria-label={`Evidence ${selected.id}`}
          className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm"
        >
          <p className="font-medium">
            {selected.id} · {capitalize(toolLabel(selected.tool))} · {STATUS[selected.status]}
          </p>
          {selected.sources.length ? (
            <ul className="space-y-1">
              {selected.sources.map((s) => (
                <li key={`${s.label}-${s.href}`}>
                  {s.href ? (
                    <Link className="text-primary hover:underline" href={s.href}>
                      {s.label}
                    </Link>
                  ) : (
                    s.label
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <pre className="max-h-64 overflow-auto rounded bg-background p-2 text-xs">
            {JSON.stringify(selected.data, null, 2)}
          </pre>
        </section>
      ) : null}
      {data.missing.length ? (
        <div className="rounded-md border border-border p-3 text-sm">
          <p className="mb-1 font-medium">Missing evidence</p>
          <ul aria-label="Missing evidence" className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {data.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
