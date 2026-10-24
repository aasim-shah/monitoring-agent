import { describe, expect, it } from 'vitest';
import { databaseActivity, trend } from './activity.js';

const pg = (tables: Array<[string, number, number]>, bytes = 1000) => ({
  databases: [{ name: 'app', bytes }],
  tables: tables.map(([name, rows, inserted]) => ({ name, rows, inserted })),
});

describe('database activity over the report window (M15b)', () => {
  it('counts PostgreSQL inserts per table from the cumulative counters, largest first', () => {
    const a = databaseActivity(
      pg(
        [
          ['public.orders', 4190, 9000],
          ['public.users', 500, 600],
        ],
        1000,
      ),
      pg(
        [
          ['public.orders', 4310, 9120],
          ['public.users', 503, 603],
          ['public.events', 7, 7],
        ],
        1500,
      ),
    );
    expect(a).toMatchObject({
      baseline: 'ok',
      approximate: false,
      rowsAdded: 130,
      sizeBytes: 1500,
      sizeChangeBytes: 500,
    });
    expect(a.top).toEqual([
      { name: 'public.orders', added: 120, total: 4310 },
      { name: 'public.events', added: 7, total: 7, isNew: true },
      { name: 'public.users', added: 3, total: 503 },
    ]);
  });

  it('says "reset" instead of a negative number when PostgreSQL statistics were reset (Review Focus #1)', () => {
    const a = databaseActivity(pg([['public.orders', 4190, 9000]]), pg([['public.orders', 4200, 15]]));
    expect(a.baseline).toBe('reset');
    expect(a.rowsAdded).toBeNull();
    expect(a.top).toEqual([{ name: 'public.orders', added: null, total: 4200 }]);
  });

  it('uses document counts for MongoDB, marked approximate', () => {
    const a = databaseActivity(
      {
        database: { dataSizeBytes: 100, objects: 5002 },
        collections: [
          { name: 'incidents', documents: 5000 },
          { name: 'stations', documents: 2 },
        ],
      },
      {
        database: { dataSizeBytes: 160, objects: 5060 },
        collections: [
          { name: 'incidents', documents: 5058 },
          { name: 'stations', documents: 2 },
        ],
      },
    );
    expect(a).toMatchObject({ baseline: 'ok', approximate: true, rowsAdded: 58, sizeChangeBytes: 60 });
    expect(a.top).toEqual([{ name: 'incidents', added: 58, total: 5058 }]);
  });

  it('has no baseline without a start snapshot (Review Focus #3)', () => {
    const a = databaseActivity(null, pg([['public.orders', 10, 10]]));
    expect(a).toMatchObject({ baseline: 'none', rowsAdded: null, sizeChangeBytes: null });
    expect(a.top).toEqual([{ name: 'public.orders', added: null, total: 10 }]);
  });

  it('formats a trend only when both values exist', () => {
    expect(trend(110, 100)).toBe('▲ 10%');
    expect(trend(90, 100)).toBe('▼ 10%');
    expect(trend(100, 100)).toBe('= 0%');
    expect(trend(5, 0)).toBe('▲ new');
    expect(trend(null, 100)).toBeNull();
    expect(trend(100, null)).toBeNull();
  });
});
