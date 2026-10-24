'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';

export interface LogLine {
  time: string;
  message: string;
  agentId: string | null;
  service: string | null;
  level: string | null;
}

const RANGES = ['1h', '6h', '24h', '7d'] as const;
type Range = (typeof RANGES)[number];

/** Retained-log search (M18.1): LogsQL filters over this host's redacted lines, newest first. */
export function LogSearch({
  search,
}: {
  search: (query: string, range: Range) => Promise<{ lines: LogLine[]; truncated: boolean }>;
}) {
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<Range>('1h');
  const [result, setResult] = useState<{ lines: LogLine[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = async () => {
    setError(null);
    setPending(true);
    try {
      setResult(await search(query.trim(), range));
    } catch (e) {
      setResult(null);
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label="Retained logs" className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label className="flex-1 space-y-1 text-sm">
          <span className="font-medium">Search retained logs</span>
          <Input
            placeholder='error  or  "connection refused"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Range</span>
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={range}
            onChange={(e) => setRange(e.target.value as Range)}
          >
            {RANGES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          Search
        </Button>
      </form>
      {error ? <Alert>{error}</Alert> : null}
      {result && result.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No retained log lines match in this range.</p>
      ) : null}
      {result?.lines.length ? (
        <ul className="max-h-96 space-y-0.5 overflow-auto rounded-md border border-border bg-muted p-2 font-mono text-xs">
          {result.lines.map((l, i) => (
            <li key={`${l.time}-${i}`} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">{l.time.replace('T', ' ').slice(0, 19)}</span>
              {l.service ? <span className="shrink-0">{l.service}</span> : null}
              {l.level ? (
                <span className={l.level === 'error' ? 'shrink-0 text-destructive' : 'shrink-0'}>
                  {l.level}
                </span>
              ) : null}
              <span className="break-all">{l.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {result?.truncated ? (
        <p className="text-xs text-muted-foreground">Showing the newest 500 lines; narrow the search.</p>
      ) : null}
    </section>
  );
}
