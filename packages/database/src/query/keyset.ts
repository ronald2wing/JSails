/**
 * Keyset pagination for batch walks: the total order a walk uses and the
 * "strictly after the cursor" condition of each page.
 *
 * The order is the query's own terms followed by every primary-key column
 * not already among them (ascending), or the primary key alone, so it is
 * total and a page boundary never splits rows that compare equal. A nullable
 * column gets an explicit null placement: the one the query asked for, or
 * NULL lowest (`first` ascending, `last` descending), the same on every
 * dialect.
 *
 * The page condition is built from the cursor's values, so it never switches
 * on a parameter (a predicate like `(? = 0 OR id > ?)` defeats SQLite's
 * index range). A single non-null column is a plain comparison, `id > ?`,
 * on every dialect; several non-null columns sorted one way become a
 * row-value comparison, `(a, id) > (?, ?)`, on PostgreSQL and SQLite. MariaDB does not turn a row-value comparison into a
 * range, and a nullable column or mixed directions have no row-value form, so
 * there the condition is the expanded lexicographic form, `a > ? OR (a = ? AND
 * id > ?)`, with explicit `IS NULL` branches for nullable columns, and on
 * MariaDB a leading `a >= ?` (or `<=`) on a non-null first column, which the
 * optimizer reads as the range.
 */

import type { CodecColumn, ModelCodecs } from '../codec/model-codecs.js';
import type { Dialect, SqlValue } from '../engine/contract.js';
import type { OrderTerm, Predicate } from '../engine/statement.js';
import { and, col, compare, eq, FALSE, isNull, or, rowCompare } from '../statement/builders.js';

/** A sort term: a column, its direction, and where NULL sorts. */
export interface SortTerm {
  readonly column: CodecColumn;
  readonly direction: 'asc' | 'desc';
  /** In a walk's order, set exactly when the column is nullable. */
  readonly nulls?: 'first' | 'last';
}

/** The walk's total order: `order` plus the primary key as tiebreak. */
export function keysetTerms(codecs: ModelCodecs, order: readonly SortTerm[]): readonly SortTerm[] {
  const terms: SortTerm[] = [];
  const seen = new Set<string>();
  const push = (term: SortTerm): void => {
    if (seen.has(term.column.property)) return;
    seen.add(term.column.property);
    terms.push(
      Object.freeze(
        term.column.nullable
          ? {
              column: term.column,
              direction: term.direction,
              nulls: term.nulls ?? (term.direction === 'asc' ? 'first' : 'last'),
            }
          : { column: term.column, direction: term.direction },
      ),
    );
  };
  order.forEach(push);
  for (const property of codecs.spec.primaryKey) {
    const column = codecs.property(property);
    if (column !== undefined) push({ column, direction: 'asc' });
  }
  return Object.freeze(terms);
}

/** The `ORDER BY` of a walk's order, qualified by `qualifier`. */
export function keysetOrder(terms: readonly SortTerm[], qualifier: string): readonly OrderTerm[] {
  return Object.freeze(
    terms.map((term) =>
      Object.freeze({
        column: col(qualifier, term.column.column),
        direction: term.direction,
        ...(term.nulls === undefined ? {} : { nulls: term.nulls }),
      }),
    ),
  );
}

/**
 * The condition "strictly after the row whose order values are `cursor`"
 * (stored values, one per term, `null` for a NULL).
 */
export function keysetAfter(
  terms: readonly SortTerm[],
  cursor: readonly SqlValue[],
  qualifier: string,
  dialect: Dialect,
): Predicate {
  const ref = (term: SortTerm) => col(qualifier, term.column.column);
  const first = terms[0];
  const direction = first?.direction;
  const uniform = terms.every(
    (term, index) =>
      term.nulls === undefined && term.direction === direction && cursor[index] !== null,
  );
  if (uniform && first !== undefined) {
    const comparison = direction === 'asc' ? '>' : '<';
    if (terms.length === 1) return compare(ref(first), comparison, cursor[0] as SqlValue);
    if (dialect !== 'mariadb') return rowCompare(terms.map(ref), comparison, cursor);
  }
  const strictly = (term: SortTerm, value: SqlValue): Predicate => {
    if (value === null) return term.nulls === 'first' ? isNull(ref(term), true) : FALSE;
    const beyond = compare(ref(term), term.direction === 'asc' ? '>' : '<', value);
    return term.nulls === 'last' ? or(beyond, isNull(ref(term))) : beyond;
  };
  const equal = (term: SortTerm, value: SqlValue): Predicate =>
    value === null ? isNull(ref(term)) : eq(ref(term), value);
  let condition: Predicate = FALSE;
  for (let index = terms.length - 1; index >= 0; index -= 1) {
    const term = terms[index] as SortTerm;
    const value = cursor[index] as SqlValue;
    condition =
      index === terms.length - 1
        ? strictly(term, value)
        : or(strictly(term, value), and(equal(term, value), condition));
  }
  const leading = cursor[0];
  if (
    dialect === 'mariadb' &&
    terms.length > 1 &&
    first !== undefined &&
    first.nulls === undefined &&
    leading !== null &&
    leading !== undefined
  ) {
    return and(compare(ref(first), first.direction === 'asc' ? '>=' : '<=', leading), condition);
  }
  return condition;
}
