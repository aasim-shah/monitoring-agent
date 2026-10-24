/** Query limits (master plan §3, BR-04-06). */
export const MAX_POINTS = 11_000;
export const MAX_SERIES = 1_000;
export const MAX_RANGE_SECONDS = 400 * 86400;
export const RAW_RETENTION_SECONDS = 15 * 86400;
/** Rollups are 5-minute averages (M18.4); a long-term query never asks for a finer step. */
export const ROLLUP_STEP_SECONDS = 300;
export const QUERY_TIMEOUT_MS = 30_000;

export interface RangePlan {
  startS: number;
  endS: number;
  stepSeconds: number;
  /** Human-readable reasons parts of the range cannot have data. */
  gaps: string[];
  /** `longterm`: the 13-month rollup store (M18.4). */
  source: 'raw' | 'longterm';
}

/** Long-term rollups are on and hold data from `since` (the ROLLUPS_SINCE setting). */
export interface Rollups {
  since: Date;
}

/**
 * Validates a range and raises the step until no series can exceed 11,000 points. A range that starts
 * before raw retention reads the rollups when they are on, at a 5-minute step or coarser.
 */
export function planRange(
  start: Date,
  end: Date,
  requestedStep: number | undefined,
  now: Date,
  rollups?: Rollups,
): RangePlan {
  const startS = Math.floor(start.getTime() / 1000);
  const endS = Math.floor(end.getTime() / 1000);
  if (endS <= startS) throw new RangeError('start must be before end');
  if (endS - startS > MAX_RANGE_SECONDS) throw new RangeError('range must not exceed 400 days');
  const retentionStart = new Date(now.getTime() - RAW_RETENTION_SECONDS * 1000);
  const source = rollups && start < retentionStart ? 'longterm' : 'raw';
  const minStep = source === 'longterm' ? ROLLUP_STEP_SECONDS : 1;
  const stepSeconds = Math.max(requestedStep ?? 60, Math.ceil((endS - startS) / MAX_POINTS), minStep);
  // VictoriaMetrics aligns query_range timestamps to multiples of the step; use the same grid.
  const alignedStart = Math.floor(startS / stepSeconds) * stepSeconds;
  // Round the end up so the newest samples are not cut off by the last step boundary.
  const alignedEnd = Math.ceil(endS / stepSeconds) * stepSeconds;
  const gaps =
    source === 'longterm'
      ? start < rollups!.since
        ? [`rollups: 5-minute data starts ${rollups!.since.toISOString()}`]
        : []
      : start < retentionStart
        ? [`retention: no raw data before ${retentionStart.toISOString()}`]
        : [];
  return { startS: alignedStart, endS: alignedEnd, stepSeconds, gaps, source };
}

/**
 * Rollup samples are 5 minutes apart, so a `[5m]` rate window would hold one sample. Windows shorter
 * than three samples (or than the step) are widened to `max(15m, step)`.
 */
export function widenWindows(promql: string, stepSeconds: number): string {
  const window = Math.max(3 * ROLLUP_STEP_SECONDS, stepSeconds);
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return promql.replace(/\[(\d+)([smhd])\]/g, (match, n: string, u: string) =>
    Number(n) * unit[u]! < window
      ? `[${window % 3600 === 0 ? `${window / 3600}h` : `${window / 60}m`}]`
      : match,
  );
}

/** Puts samples on the step grid; steps without a sample (or NaN) are null, never 0 (BR-04-07). */
export function toGrid(
  values: Array<[number, string]>,
  startS: number,
  endS: number,
  stepSeconds: number,
): Array<[number, number | null]> {
  const byTime = new Map(values.map(([t, v]) => [Math.round(t), Number(v)]));
  const out: Array<[number, number | null]> = [];
  for (let t = startS; t <= endS; t += stepSeconds) {
    const v = byTime.get(t);
    out.push([t, v === undefined || Number.isNaN(v) ? null : v]);
  }
  return out;
}
