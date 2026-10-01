/**
 * Which rows a write names, decided by the shape of its condition alone:
 * when the top-level `AND` of an update's or delete's `WHERE` holds an
 * equality or `IN` on the primary key (an equality on every column of a
 * composite key), the rows it can change are among those keys, and the write
 * reports one record per key; anything else is an `invalidate`. Nothing is
 * read to find out, so the answer can be a superset of the rows actually
 * changed (a key the rest of the condition excluded), never a subset.
 */

import { decodeColumn, type CodecColumn, type ModelCodecs } from '../codec/model-codecs.js';
import type { SqlValue } from '../engine/contract.js';
import type { ColumnRef, Predicate } from '../engine/statement.js';
import { keyIdentity, type ChangeKey } from './change-record.js';

function terms(predicate: Predicate): readonly Predicate[] {
  return predicate.op === 'and' ? predicate.items.flatMap(terms) : [predicate];
}

function names(ref: ColumnRef, table: string, column: string): boolean {
  return typeof ref === 'string' ? ref === column : ref.column === column && ref.table === table;
}

/** The values the top-level terms allow `column`, or `undefined` when none restricts it. */
function allowedValues(
  items: readonly Predicate[],
  table: string,
  column: string,
): readonly SqlValue[] | undefined {
  let allowed: readonly SqlValue[] | undefined;
  for (const item of items) {
    let values: readonly SqlValue[] | undefined;
    if (item.op === 'compare' && item.comparison === '=' && names(item.column, table, column)) {
      values = [item.value];
    } else if (item.op === 'in' && item.negate !== true && names(item.column, table, column)) {
      values = item.values;
    } else if (item.op === 'false') {
      values = [];
    }
    if (values === undefined) continue;
    if (allowed === undefined) allowed = values;
    else {
      const kept = new Set(values.map((value) => String(value)));
      allowed = allowed.filter((value) => kept.has(String(value)));
    }
  }
  return allowed;
}

/** The application key of a stored primary-key value of a one-column key. */
function decodeKey(column: CodecColumn, value: SqlValue): ChangeKey {
  return decodeColumn(column, value) as ChangeKey;
}

/**
 * The primary keys `where` restricts a write on `codecs`' model to, decoded
 * and without duplicates; `undefined` when the condition is not a key
 * lookup.
 */
export function predicateKeys(
  codecs: ModelCodecs,
  where: Predicate,
): readonly ChangeKey[] | undefined {
  const items = terms(where);
  const table = codecs.spec.table;
  const columns = codecs.spec.primaryKey.map(
    (property) => codecs.property(property) as CodecColumn,
  );
  if (columns.length === 1) {
    const column = columns[0] as CodecColumn;
    const values = allowedValues(items, table, column.column);
    if (values === undefined) return undefined;
    const seen = new Map<string, ChangeKey>();
    for (const value of values) {
      if (value === null) continue;
      const key = decodeKey(column, value);
      seen.set(keyIdentity(key), key);
    }
    return Object.freeze([...seen.values()]);
  }
  const key: Record<string, unknown> = {};
  for (const column of columns) {
    const values = allowedValues(items, table, column.column);
    if (values === undefined || values.length > 1) return undefined;
    const value = values[0];
    if (value === undefined || value === null) return Object.freeze([]);
    key[column.property] = decodeColumn(column, value);
  }
  return Object.freeze([Object.freeze(key)]);
}
