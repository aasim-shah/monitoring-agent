export type Unit = 'percent' | 'bytesPerSecond';

/** Display text for a metric value; callers render null as "no data", never 0. */
export function formatValue(value: number, unit: Unit): string {
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = value;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatClock(epochSeconds: number, withDate = false): string {
  const d = new Date(epochSeconds * 1000);
  return withDate
    ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
