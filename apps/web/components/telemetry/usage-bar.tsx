const HIGH = 90;

/** Current usage as a meter with its value in text; "High" is labelled, never color alone. */
export function UsageBar({ label, percent }: { label: string; percent: number | null }) {
  if (percent === null)
    return (
      <div className="min-w-24 text-xs">
        <div className="text-muted-foreground">{label}</div>
        <div className="text-muted-foreground">no data</div>
      </div>
    );
  const value = Math.max(0, Math.min(100, percent));
  const high = value >= HIGH;
  return (
    <div className="min-w-24 space-y-1 text-xs">
      <div className="flex justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-foreground">
          {Math.round(value)}%{high ? <span className="ml-1 text-destructive">High</span> : null}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${value}%`, background: high ? 'var(--destructive)' : 'var(--series-1)' }}
        />
      </div>
    </div>
  );
}
