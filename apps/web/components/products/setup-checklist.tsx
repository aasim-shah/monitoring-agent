import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import type { SetupStep } from '@/lib/setup-steps';

const MARK: Record<SetupStep['status'], string> = { done: '✓', todo: '○', soon: '○' };

export function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const done = steps.filter((s) => s.status === 'done').length;
  return (
    <Card className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <CardTitle className="text-base">Set up monitoring</CardTitle>
          <CardDescription>
            Connect what this product runs on. Each step shows what it collects.
          </CardDescription>
        </div>
        <span className="shrink-0 text-sm text-muted-foreground">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="divide-y divide-border">
        {steps.map((step) => (
          <li key={step.id} className="flex gap-3 py-3">
            <span
              aria-hidden
              className={cn(
                'mt-0.5 text-sm',
                step.status === 'done' ? 'text-green-600' : 'text-muted-foreground',
              )}
            >
              {MARK[step.status]}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('font-medium', step.status === 'soon' && 'text-muted-foreground')}>
                  {step.title}
                </span>
                {step.status === 'soon' ? <Badge>Coming soon</Badge> : null}
                {step.status === 'done' ? <Badge className="text-green-600">Done</Badge> : null}
              </div>
              <p className="text-sm text-muted-foreground">{step.description}</p>
              <p className="text-xs text-muted-foreground">Collects: {step.collects}</p>
            </div>
            {step.href && step.status !== 'done' ? (
              <Link href={step.href} className="shrink-0 self-center text-sm font-medium underline">
                {step.actionLabel ?? 'Start'}
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
