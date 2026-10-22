'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardTitle } from '@/components/ui/card';
import { formatClock, formatValue, type Unit } from '@/lib/format';

export type Point = [number, number | null];
export interface Series {
  key: string;
  label: string;
  points: Point[];
}

/** Categorical slots in fixed order (validated in light and dark); at most three series per chart. */
const SLOTS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

type Row = { t: number } & Record<string, number | null>;

/** One row per timestamp; a series without a sample at that time is null, so its line breaks. */
export function toRows(series: Series[]): Row[] {
  const rows = new Map<number, Row>();
  for (const s of series) {
    for (const [t, v] of s.points) {
      const row = rows.get(t) ?? ({ t } as Row);
      row[s.key] = v;
      rows.set(t, row);
    }
  }
  const sorted = [...rows.values()].sort((a, b) => a.t - b.t);
  for (const row of sorted) for (const s of series) if (!(s.key in row)) row[s.key] = null;
  return sorted;
}

/** A sample with no sample on either side draws no line segment, so it gets a dot instead. */
export function isIsolated(rows: Row[], key: string, i: number): boolean {
  if (rows[i]?.[key] === null || rows[i]?.[key] === undefined) return false;
  const prev = rows[i - 1]?.[key];
  const next = rows[i + 1]?.[key];
  return (prev === null || prev === undefined) && (next === null || next === undefined);
}

/**
 * Line chart for one host metric. Missing samples are gaps (connectNulls off), never
 * zero (BR-04-07). Single series: the title names it. Several: legend plus a data table.
 */
export function MetricChart({
  title,
  unit,
  series,
  multiDay = false,
}: {
  title: string;
  unit: Unit;
  series: Series[];
  multiDay?: boolean;
}) {
  const shown = series.slice(0, SLOTS.length);
  const rows = toRows(shown);
  const hasData = rows.some((r) => shown.some((s) => r[s.key] !== null));
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {shown.length > 1 ? (
          <ul aria-label="Legend" className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {shown.map((s, i) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-0.5 w-4 rounded"
                  style={{ background: SLOTS[i] }}
                />
                {s.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {hasData ? (
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t: number) => formatClock(t, multiDay)}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                stroke="var(--chart-grid)"
                minTickGap={40}
              />
              <YAxis
                width={64}
                domain={unit === 'percent' ? [0, 100] : [0, 'auto']}
                tickFormatter={(v: number) => formatValue(v, unit)}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                stroke="var(--chart-grid)"
              />
              <Tooltip
                cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                contentStyle={{
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--foreground)',
                  fontSize: 12,
                }}
                labelFormatter={(t) => formatClock(Number(t), true)}
                formatter={(v, name) => [
                  v === null || v === undefined ? 'no data' : formatValue(Number(v), unit),
                  String(name),
                ]}
              />
              {shown.map((s, i) => (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stroke={SLOTS[i]}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={(props: { cx?: number; cy?: number; index?: number }) =>
                    props.index !== undefined &&
                    isIsolated(rows, s.key, props.index) &&
                    props.cx !== undefined ? (
                      <circle
                        key={`${s.key}-${props.index}`}
                        cx={props.cx}
                        cy={props.cy}
                        r={4}
                        fill={SLOTS[i]}
                        stroke="var(--card)"
                        strokeWidth={2}
                      />
                    ) : (
                      <g key={`${s.key}-${props.index}`} />
                    )
                  }
                  activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">No data in this range.</p>
      )}
      {hasData ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Data table</summary>
          <div className="mt-2 max-h-48 overflow-auto">
            <table className="w-full text-left">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Time</th>
                  {shown.map((s) => (
                    <th key={s.key} className="py-1 pr-3 font-medium">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.t} className="border-t border-border">
                    <td className="py-1 pr-3">{formatClock(r.t, multiDay)}</td>
                    {shown.map((s) => (
                      <td key={s.key} className="py-1 pr-3">
                        {r[s.key] === null ? (
                          <span className="text-muted-foreground">no data</span>
                        ) : (
                          formatValue(r[s.key]!, unit)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Card>
  );
}
