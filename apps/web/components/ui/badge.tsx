import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'pcp-badge inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
