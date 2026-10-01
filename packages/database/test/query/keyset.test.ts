/**
 * The keyset rules, rendered: the walk order appends the primary key and
 * places NULL explicitly on nullable columns; the "after the cursor"
 * condition is a plain comparison for one column on every dialect, a
 * row-value comparison for several uniform non-null columns on PostgreSQL
 * and SQLite, the expanded form with a leading range term on MariaDB, and
 * explicit `IS NULL` branches for a nullable column, built from the cursor's
 * values (never switching on a parameter).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compileStatement,
  createStatementCatalog,
  ir,
  type Dialect,
  type SqlValue,
} from '../../src/index.js';
import { keysetAfter, keysetOrder, keysetTerms, type SortTerm } from '../../src/query/keyset.js';
import { Event } from './fixtures/event-model.js';

const codecs = createStatementCatalog({ dialect: 'sqlite', models: [Event] }).codecs(Event);

function term(
  property: string,
  direction: 'asc' | 'desc' = 'asc',
  nulls?: 'first' | 'last',
): SortTerm {
  const column = codecs.property(property);
  assert.ok(column !== undefined);
  return nulls === undefined ? { column, direction } : { column, direction, nulls };
}

function whereOf(
  order: readonly SortTerm[],
  cursor: readonly SqlValue[],
  dialect: Dialect,
): { sql: string; params: readonly unknown[] } {
  const terms = keysetTerms(codecs, order);
  const statement = ir.select(ir.table('q_events'), {
    columns: [{ column: ir.col('q_events', 'id'), as: 'id' }],
    where: keysetAfter(terms, cursor, 'q_events', dialect),
  });
  const compiled = compileStatement(statement, dialect);
  return { sql: compiled.sql.slice(compiled.sql.indexOf('WHERE ') + 6), params: compiled.params };
}

describe('keyset', () => {
  it('orders by the query terms, then the primary key, with NULL placed explicitly', () => {
    const terms = keysetTerms(codecs, [term('rank', 'desc'), term('at')]);
    assert.deepEqual(
      terms.map((item) => [item.column.property, item.direction, item.nulls]),
      [
        ['rank', 'desc', 'last'],
        ['at', 'asc', undefined],
        ['id', 'asc', undefined],
      ],
    );
    assert.deepEqual(
      keysetTerms(codecs, [term('id', 'desc')]).map((item) => item.column.property),
      ['id'],
    );
    const order = keysetOrder(keysetTerms(codecs, [term('rank', 'asc', 'last')]), 'q_events');
    assert.deepEqual(
      order.map((item) => [item.direction, item.nulls]),
      [
        ['asc', 'last'],
        ['asc', undefined],
      ],
    );
  });

  it('continues after one column with a plain comparison on every dialect', () => {
    for (const dialect of ['sqlite', 'postgres', 'mariadb'] as const) {
      const { sql, params } = whereOf([], [41], dialect);
      assert.match(sql, /^[`"]q_events[`"]\.[`"]id[`"] > (\?|\$1)$/);
      assert.deepEqual(params, [41]);
    }
    assert.match(whereOf([term('id', 'desc')], [41], 'sqlite').sql, / < \?$/);
  });

  it('uses a row-value comparison for uniform non-null columns on PostgreSQL and SQLite', () => {
    const { sql, params } = whereOf([term('at')], ['2024-01-01', 7], 'postgres');
    assert.equal(sql, '("q_events"."at", "q_events"."id") > ($1, $2)');
    assert.deepEqual(params, ['2024-01-01', 7]);
    assert.match(
      whereOf([term('at', 'desc'), term('id', 'desc')], ['x', 7], 'sqlite').sql,
      /\) < \(/,
    );
  });

  it('expands with a leading range term on MariaDB, and for mixed directions everywhere', () => {
    const maria = whereOf([term('at')], ['2024-01-01', 7], 'mariadb');
    assert.equal(
      maria.sql,
      '(`q_events`.`at` >= ?) AND ((`q_events`.`at` > ?) OR ((`q_events`.`at` = ?) AND (`q_events`.`id` > ?)))',
    );
    assert.deepEqual(maria.params, ['2024-01-01', '2024-01-01', '2024-01-01', 7]);
    const mixed = whereOf([term('at', 'desc')], ['2024-01-01', 7], 'sqlite');
    assert.equal(
      mixed.sql,
      '("q_events"."at" < ?) OR (("q_events"."at" = ?) AND ("q_events"."id" > ?))',
    );
  });

  it('branches on NULL explicitly for a nullable column, from the cursor value', () => {
    // NULL lowest ascending: after a NULL rank come the other NULLs by key, then every rank.
    assert.equal(
      whereOf([term('rank')], [null, 7], 'sqlite').sql,
      '("q_events"."rank" IS NOT NULL) OR (("q_events"."rank" IS NULL) AND ("q_events"."id" > ?))',
    );
    assert.equal(
      whereOf([term('rank')], [3, 7], 'postgres').sql,
      '("q_events"."rank" > $1) OR (("q_events"."rank" = $2) AND ("q_events"."id" > $3))',
    );
    // NULL lowest descending sorts last: beyond a rank lie lower ranks and every NULL.
    assert.equal(
      whereOf([term('rank', 'desc')], [3, 7], 'sqlite').sql,
      '("q_events"."rank" < ?) OR ("q_events"."rank" IS NULL) OR (("q_events"."rank" = ?) AND ("q_events"."id" > ?))',
    );
    // After a NULL that sorts last, only NULLs with a greater key remain.
    assert.equal(
      whereOf([term('rank', 'desc')], [null, 7], 'mariadb').sql,
      '(`q_events`.`rank` IS NULL) AND (`q_events`.`id` > ?)',
    );
  });
});
