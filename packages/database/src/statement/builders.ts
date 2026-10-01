/**
 * Builders for the statement IR (`engine/statement.ts`): small functions that
 * return frozen plain data, so a statement built once can be shared, compared
 * and rewritten by the policy without anyone changing it underneath. They
 * add no meaning of their own; every shape they build can be written as a
 * literal. `and` and `or` flatten nested items of the same kind and drop the
 * neutral element, so composed conditions stay shallow.
 */

import type { SqlValue } from '../engine/contract.js';
import type {
  Assignment,
  ColumnRef,
  Comparison,
  DeleteStatement,
  InsertStatement,
  Join,
  OnConflict,
  Predicate,
  RowComparison,
  SelectStatement,
  TableRef,
  UpdateStatement,
} from '../engine/statement.js';

/** Deep-freeze plain statement data; bound byte values are left as they are. */
export function freezeStatement<T>(value: T): T {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value;
  if (Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freezeStatement(item);
  return Object.freeze(value);
}

/** The always-true condition: an explicit "every row". */
export const TRUE: Predicate = Object.freeze({ op: 'true' });

/** The always-false condition. */
export const FALSE: Predicate = Object.freeze({ op: 'false' });

/** A column of a named table or alias. */
export function col(table: string, column: string): ColumnRef {
  return Object.freeze({ table, column });
}

/** `column <comparison> value`. */
export function compare(column: ColumnRef, comparison: Comparison, value: SqlValue): Predicate {
  return freezeStatement({ op: 'compare', column, comparison, value });
}

/** `column = value`. */
export function eq(column: ColumnRef, value: SqlValue): Predicate {
  return compare(column, '=', value);
}

/** `left <comparison> right`: a join or correlation condition. */
export function compareColumns(
  left: ColumnRef,
  comparison: Comparison,
  right: ColumnRef,
): Predicate {
  return freezeStatement({ op: 'compare-columns', left, comparison, right });
}

/** `column IN (values)`, or `NOT IN` when `negate`. */
export function inList(column: ColumnRef, values: readonly SqlValue[], negate = false): Predicate {
  return freezeStatement({ op: 'in', column, values: [...values], ...(negate ? { negate } : {}) });
}

/** `columns IN (SELECT ...)`, or `NOT IN` when `negate`. */
export function inSelect(
  columns: ColumnRef | readonly ColumnRef[],
  select: SelectStatement,
  negate = false,
): Predicate {
  const list: readonly ColumnRef[] = Array.isArray(columns)
    ? (columns as readonly ColumnRef[])
    : [columns as ColumnRef];
  return freezeStatement({
    op: 'in-select',
    columns: [...list],
    select,
    ...(negate ? { negate } : {}),
  });
}

/** `EXISTS (SELECT ...)`, or `NOT EXISTS` when `negate`. */
export function exists(select: SelectStatement, negate = false): Predicate {
  return freezeStatement({ op: 'exists', select, ...(negate ? { negate } : {}) });
}

/** `(columns) <comparison> (values)`: a keyset page condition. */
export function rowCompare(
  columns: readonly ColumnRef[],
  comparison: RowComparison,
  values: readonly SqlValue[],
): Predicate {
  return freezeStatement({
    op: 'row-compare',
    columns: [...columns],
    comparison,
    values: [...values],
  });
}

/** `column IS NULL`, or `IS NOT NULL` when `negate`. */
export function isNull(column: ColumnRef, negate = false): Predicate {
  return freezeStatement({ op: 'null', column, ...(negate ? { negate } : {}) });
}

/** `column LIKE pattern ESCAPE '\'`, or `NOT LIKE` when `negate`. */
export function like(column: ColumnRef, pattern: string, negate = false): Predicate {
  return freezeStatement({ op: 'like', column, pattern, ...(negate ? { negate } : {}) });
}

function combine(op: 'and' | 'or', items: readonly Predicate[]): Predicate {
  const neutral = op === 'and' ? 'true' : 'false';
  const absorbing = op === 'and' ? 'false' : 'true';
  const flat: Predicate[] = [];
  for (const item of items) {
    if (item.op === neutral) continue;
    if (item.op === absorbing) return item;
    if (item.op === op) flat.push(...item.items);
    else flat.push(item);
  }
  if (flat.length === 0) return op === 'and' ? TRUE : FALSE;
  if (flat.length === 1) return flat[0] as Predicate;
  return freezeStatement({ op, items: flat });
}

/** Every item holds; `TRUE` for none. */
export function and(...items: readonly Predicate[]): Predicate {
  return combine('and', items);
}

/** Some item holds; `FALSE` for none. */
export function or(...items: readonly Predicate[]): Predicate {
  return combine('or', items);
}

/** The item does not hold. */
export function not(item: Predicate): Predicate {
  return freezeStatement({ op: 'not', item });
}

/** A table, optionally aliased. */
export function table(name: string, alias?: string): TableRef {
  return Object.freeze(alias === undefined ? { table: name } : { table: name, alias });
}

/** `INNER JOIN` (or `LEFT JOIN`) `joined` `ON on`. */
export function join(joined: string | TableRef, on: Predicate, kind: Join['kind'] = 'inner'): Join {
  return freezeStatement({ kind, table: typeof joined === 'string' ? table(joined) : joined, on });
}

/** A select; `columns` defaults to `'*'`. */
export function select(
  from: string | TableRef,
  parts: Partial<Omit<SelectStatement, 'kind' | 'from'>> = {},
): SelectStatement {
  return freezeStatement({
    kind: 'select',
    from: typeof from === 'string' ? table(from) : from,
    columns: '*',
    ...parts,
  });
}

/** An insert of `rows`, each giving `columns` in order. */
export function insert(
  into: string,
  columns: readonly string[],
  rows: readonly (readonly SqlValue[])[],
  options: { readonly onConflict?: OnConflict; readonly returning?: readonly string[] } = {},
): InsertStatement {
  return freezeStatement({
    kind: 'insert',
    table: into,
    columns: [...columns],
    rows: rows.map((row) => [...row]),
    ...options,
  });
}

/** An update; `where` is required, `TRUE` for every row. */
export function update(
  target: string,
  set: readonly Assignment[],
  where: Predicate,
  returning?: readonly string[],
): UpdateStatement {
  return freezeStatement({
    kind: 'update',
    table: target,
    set: [...set],
    where,
    ...(returning === undefined ? {} : { returning: [...returning] }),
  });
}

/** A delete; `where` is required, `TRUE` for every row. */
export function deleteFrom(
  target: string,
  where: Predicate,
  returning?: readonly string[],
): DeleteStatement {
  return freezeStatement({
    kind: 'delete',
    table: target,
    where,
    ...(returning === undefined ? {} : { returning: [...returning] }),
  });
}
