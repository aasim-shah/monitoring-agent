export type Unit = 'percent' | 'bytesPerSecond' | 'bytes' | 'count' | 'perSecond';

function scaled(value: number, units: string[]): string {
  let v = value;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const plain = (v: number) =>
  Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : String(Number(v.toFixed(2)));

/** Display text for a metric value; callers render null as "no data", never 0. */
export function formatValue(value: number, unit: Unit): string {
  switch (unit) {
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'bytesPerSecond':
      return scaled(value, ['B/s', 'KB/s', 'MB/s', 'GB/s']);
    case 'bytes':
      return scaled(value, ['B', 'KB', 'MB', 'GB', 'TB']);
    case 'count':
      return plain(value);
    case 'perSecond':
      return `${plain(value)}/s`;
  }
}

export function formatClock(epochSeconds: number, withDate = false): string {
  const d = new Date(epochSeconds * 1000);
  return withDate
    ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
