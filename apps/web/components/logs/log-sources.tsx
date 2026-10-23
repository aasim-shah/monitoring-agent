'use client';

import { Button } from '@/components/ui/button';
import type { LogSource } from './log-viewer';

/** One button per source the agent allows; nothing for members without `logs.tail`. */
export function LogSources({
  sources,
  canTail,
  onOpen,
}: {
  sources: LogSource[];
  canTail: boolean;
  onOpen: (source: LogSource) => void;
}) {
  if (!canTail) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {sources.map((s) => (
        <Button key={s.id} size="sm" variant="outline" onClick={() => onOpen(s)}>
          {s.label}
        </Button>
      ))}
    </div>
  );
}
