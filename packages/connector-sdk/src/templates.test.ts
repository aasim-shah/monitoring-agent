import { describe, expect, it } from 'vitest';
import { defineTemplate } from './index.js';

const sql = (query: string) => () =>
  defineTemplate({ name: 't', description: 'd', engine: 'postgres', query });

describe('defineTemplate (BR-07-02, TC-07-04)', () => {
  it('accepts read-only SELECT and WITH statements', () => {
    expect(sql('SELECT count(*) FROM {{table}} WHERE created_at >= $1 AND created_at < $2')()).toMatchObject({
      name: 't',
      engine: 'postgres',
    });
    expect(sql('WITH d AS (SELECT 1 AS x) SELECT x FROM d;')).not.toThrow();
    // Keywords inside string literals or identifiers are fine.
    expect(sql("SELECT 'delete me' AS label, updated_at FROM t")).not.toThrow();
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET x = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'SELECT 1; DELETE FROM t',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'SELECT * INTO new_table FROM t',
    'SELECT pg_terminate_backend(123)',
    "SELECT set_config('x', 'y', false)",
    "SELECT nextval('s')",
    'SELECT * FROM t FOR UPDATE',
    'COPY t TO STDOUT',
    '/* SELECT */ TRUNCATE t',
    'SELECT 1 -- harmless\n; ALTER TABLE t ADD c int',
  ])('refuses %s', (query) => {
    expect(sql(query)).toThrow(/read-only/);
  });

  it('refuses MongoDB stages and operators that write or run code', () => {
    const mongo = (pipeline: unknown[]) => () =>
      defineTemplate({ name: 'm', description: 'd', engine: 'mongodb', pipeline });
    expect(mongo([{ $match: { status: 'active' } }, { $count: 'n' }])).not.toThrow();
    for (const bad of [
      [{ $out: 'x' }],
      [{ $merge: { into: 'x' } }],
      [{ $match: { $where: 'sleep(1)' } }],
      [{ $group: { _id: null, x: { $accumulator: {} } } }],
      [{ $addFields: { x: { $function: { body: '' } } } }],
    ])
      expect(mongo(bad)).toThrow(/read-only/);
  });
});
