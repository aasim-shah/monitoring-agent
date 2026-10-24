/**
 * Database activity over a report window (M15b): the change between the health snapshots at the
 * window's start and end. Statistics only (row counts, never rows).
 */
export interface DatabaseActivity {
  /** `none`: no snapshot at the start; `reset`: PostgreSQL statistics were reset in the window. */
  baseline: 'ok' | 'none' | 'reset';
  /** MySQL and MongoDB counts are estimates. */
  approximate: boolean;
  rowsAdded: number | null;
  sizeBytes: number | null;
  sizeChangeBytes: number | null;
  /** The tables or collections that grew most (at most 10). */
  top: Array<{ name: string; added: number | null; total: number; isNew?: true }>;
}

type Health = Record<string, unknown> | null | undefined;
interface Counted {
  name: string;
  total: number;
  /** PostgreSQL cumulative inserts; exact when present. */
  inserted?: number;
}

function counted(h: Health): Counted[] | null {
  if (!h) return null;
  if (Array.isArray(h.tables))
    return (h.tables as Array<{ name: string; rows: number; inserted?: number }>).map((t) => ({
      name: t.name,
      total: t.rows,
      ...(typeof t.inserted === 'number' ? { inserted: t.inserted } : {}),
    }));
  if (Array.isArray(h.collections))
    return (h.collections as Array<{ name: string; documents: number }>).map((c) => ({
      name: c.name,
      total: c.documents,
    }));
  return null;
}

function size(h: Health): number | null {
  if (!h) return null;
  const db = h.database as { dataSizeBytes?: number } | undefined;
  if (typeof db?.dataSizeBytes === 'number') return db.dataSizeBytes;
  const list = (h.databases ?? h.schemas) as Array<{ bytes: number }> | undefined;
  return Array.isArray(list) ? list.reduce((n, d) => n + (d.bytes ?? 0), 0) : null;
}

const TOP = 10;

export function databaseActivity(start: Health, end: Health): DatabaseActivity {
  const now = counted(end) ?? [];
  const before = counted(start);
  const approximate = !now.some((t) => t.inserted !== undefined);
  const endSize = size(end);
  const startSize = size(start);
  if (!before) {
    return {
      baseline: 'none',
      approximate,
      rowsAdded: null,
      sizeBytes: endSize,
      sizeChangeBytes: null,
      top: now.slice(0, TOP).map((t) => ({ name: t.name, added: null, total: t.total })),
    };
  }
  const prev = new Map(before.map((t) => [t.name, t]));
  const reset = now.some((t) => {
    const p = prev.get(t.name);
    return t.inserted !== undefined && p?.inserted !== undefined && t.inserted < p.inserted;
  });
  const rows = now.map((t) => {
    const p = prev.get(t.name);
    if (!p) return { name: t.name, added: t.inserted ?? t.total, total: t.total, isNew: true as const };
    if (reset) return { name: t.name, added: null, total: t.total };
    const added =
      t.inserted !== undefined && p.inserted !== undefined ? t.inserted - p.inserted : t.total - p.total;
    return { name: t.name, added, total: t.total };
  });
  const top = reset
    ? rows.slice(0, TOP)
    : rows
        .filter((r) => (r.added ?? 0) > 0)
        .sort((a, b) => (b.added ?? 0) - (a.added ?? 0) || a.name.localeCompare(b.name))
        .slice(0, TOP);
  return {
    baseline: reset ? 'reset' : 'ok',
    approximate,
    rowsAdded: reset ? null : rows.reduce((n, r) => n + Math.max(0, r.added ?? 0), 0),
    sizeBytes: endSize,
    sizeChangeBytes: endSize !== null && startSize !== null ? endSize - startSize : null,
    top,
  };
}

/** "▲ 12%" / "▼ 5%" / "= 0%" against the previous value; null unless both exist (never a trend from nothing). */
export function trend(
  current: number | null | undefined,
  previous: number | null | undefined,
): string | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? '= 0%' : '▲ new';
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  return pct > 0 ? `▲ ${pct}%` : pct < 0 ? `▼ ${-pct}%` : '= 0%';
}
