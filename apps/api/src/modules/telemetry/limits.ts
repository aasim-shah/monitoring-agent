/** Query limits (master plan §3, BR-04-06). */
export const MAX_POINTS = 11_000;
export const MAX_SERIES = 1_000;
export const MAX_RANGE_SECONDS = 400 * 86400;
export const RAW_RETENTION_SECONDS = 15 * 86400;
export const QUERY_TIMEOUT_MS = 30_000;

export interface RangePlan {
  startS: number;
  endS: number;
  stepSeconds: number;
  /** Human-readable reasons parts of the range cannot have data. */
  gaps: string[];
}

/** Validates a range and raises the step until no series can exceed 11,000 points. */
export function planRange(start: Date, end: Date, requestedStep: number | undefined, now: Date): RangePlan {
  const startS = Math.floor(start.getTime() / 1000);
  const endS = Math.floor(end.getTime() / 1000);
  if (endS <= startS) throw new RangeError('start must be before end');
  if (endS - startS > MAX_RANGE_SECONDS) throw new RangeError('range must not exceed 400 days');
  const stepSeconds = Math.max(requestedStep ?? 60, Math.ceil((endS - startS) / MAX_POINTS), 1);
  // VictoriaMetrics aligns query_range timestamps to multiples of the step; use the same grid.
  const alignedStart = Math.floor(startS / stepSeconds) * stepSeconds;
  // Round the end up so the newest samples are not cut off by the last step boundary.
  const alignedEnd = Math.ceil(endS / stepSeconds) * stepSeconds;
  const retentionStart = new Date(now.getTime() - RAW_RETENTION_SECONDS * 1000);
  const gaps =
    start < retentionStart ? [`retention: no raw data before ${retentionStart.toISOString()}`] : [];
  return { startS: alignedStart, endS: alignedEnd, stepSeconds, gaps };
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
