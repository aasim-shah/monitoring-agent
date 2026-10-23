'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/** The view keeps the newest lines only; older ones are gone (nothing is stored). */
export const MAX_LINES = 2000;

export interface LogSource {
  id: string;
  label: string;
}

export interface TailHandlers {
  onEvent(event: string, data: unknown): void;
  onError(message: string): void;
  onClose(): void;
}

/** Opens the stream and returns a function that closes it. */
export type Connect = (handlers: TailHandlers) => () => void;

type Status = 'connecting' | 'waiting' | 'live' | 'ended' | 'error';

const STATUS: Record<Status, { label: string; className: string }> = {
  connecting: { label: 'Connecting…', className: 'animate-pulse' },
  waiting: { label: 'Waiting for new lines…', className: 'animate-pulse' },
  live: { label: 'Live', className: 'border-success/40 text-success' },
  ended: { label: 'Stream ended', className: '' },
  error: { label: 'Stopped', className: 'border-destructive/40 text-destructive' },
};

interface Line {
  id: number;
  text: string;
}

const keepLast = (lines: Line[]) => (lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines);

/**
 * Live tail of one source (WB-12 UC-12-01): lines arrive already masked by the agent, and
 * closing the panel closes the stream, which stops the tail on the server.
 */
export function LogViewer({
  source,
  connect,
  onClose,
}: {
  source: LogSource;
  connect: Connect;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const pending = useRef<Line[]>([]);
  const pausedRef = useRef(false);
  const nextId = useRef(0);
  const logRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const disconnect = connect({
      onEvent(event, data) {
        if (event === 'ready') setStatus('waiting');
        else if (event === 'lines') {
          const incoming = ((data as { lines?: string[] }).lines ?? []).map((text) => ({
            id: nextId.current++,
            text,
          }));
          setStatus('live');
          if (pausedRef.current) {
            pending.current = keepLast([...pending.current, ...incoming]);
            setPendingCount(pending.current.length);
          } else setLines((prev) => keepLast([...prev, ...incoming]));
        } else if (event === 'end') setStatus('ended');
        else if (event === 'error') {
          setStatus('error');
          setError((data as { message?: string }).message ?? 'The log stream failed.');
        }
      },
      onError(message) {
        setStatus('error');
        setError(message);
      },
      onClose() {
        setStatus((s) => (s === 'error' ? s : 'ended'));
      },
    });
    return disconnect;
  }, [connect]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const togglePause = () => {
    if (pausedRef.current) {
      const flushed = pending.current;
      pending.current = [];
      setPendingCount(0);
      setLines((prev) => keepLast([...prev, ...flushed]));
    }
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  };

  const s = STATUS[status];
  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-card p-4"
      aria-label={`${source.label} live tail`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{source.label}</h3>
        <Badge className={cn(s.className)}>{s.label}</Badge>
        {paused && pendingCount ? (
          <span className="text-xs text-muted-foreground">
            {pendingCount} new line{pendingCount === 1 ? '' : 's'}
          </span>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={togglePause}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLines([])}>
            Clear
          </Button>
          <Button size="sm" variant="ghost" aria-label="Close logs" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <ol
        ref={logRef}
        role="log"
        aria-live="off"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="h-80 overflow-y-auto rounded-md bg-muted/40 p-2 font-mono text-xs leading-5"
      >
        {lines.map((l) => {
          const notice = l.text.startsWith('[pcp] ');
          return (
            <li
              key={l.id}
              data-kind={notice ? 'notice' : 'line'}
              className={cn('whitespace-pre-wrap break-all', notice && 'italic text-warning')}
            >
              {l.text}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">
        Masked on the server before sending; nothing is stored. Shows the last{' '}
        {MAX_LINES.toLocaleString('en')} lines.
      </p>
    </section>
  );
}
