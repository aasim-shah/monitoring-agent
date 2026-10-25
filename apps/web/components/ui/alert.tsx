import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Alert({
  className,
  tone = 'error',
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: 'error' | 'info' | 'success' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pcp-alert rounded-md border px-3 py-2 text-sm',
        tone === 'error' && 'border-destructive/40 bg-destructive/10 text-destructive',
        tone === 'info' && 'border-border bg-muted',
        tone === 'success' && 'border-success/40 bg-success/10 text-success',
        className,
      )}
      {...props}
    >
      {tone === 'error' ? (
        <CircleAlert size={18} aria-hidden="true" />
      ) : tone === 'success' ? (
        <CircleCheck size={18} aria-hidden="true" />
      ) : (
        <Info size={18} aria-hidden="true" />
      )}
      <div className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}
