/**
 * Values to write, lowered for one model: a `SET` map becomes the IR's
 * assignments and a list of rows becomes an insert's columns and value
 * rows, every value encoded by its column's codec (so a data contract, an
 * enum and the seal apply to writes as they do to lookups) and every
 * property mapped to its physical column.
 */

import type { SqlValue } from '../engine/contract.js';
import type { Assignment } from '../engine/statement.js';
import { reportedName } from '../codec/codec-errors.js';
import { encodeColumn, type CodecColumn, type ModelCodecs } from '../codec/model-codecs.js';
import { StatementErrors } from './statement-errors.js';
import type { ColumnKey } from './where.js';

/** Column values of rows `T` to write; `undefined` means "not written". */
export type Values<T> = { readonly [K in ColumnKey<T>]?: T[K] };

/** The encoded value rows of an insert, with the physical columns they give. */
export interface EncodedRows {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlValue[])[];
}

function invalid(codecs: ModelCodecs, field: string): never {
  throw new StatementErrors.Error('invalid_values', { model: codecs.spec.name, field });
}

function written(
  codecs: ModelCodecs,
  values: unknown,
  field: string,
): readonly [CodecColumn, unknown][] {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    invalid(codecs, field);
  }
  const pairs: [CodecColumn, unknown][] = [];
  for (const [property, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const column = codecs.property(property);
    if (column === undefined) {
      throw new StatementErrors.Error('unknown_column', {
        model: codecs.spec.name,
        field: reportedName(property),
      });
    }
    pairs.push([column, value]);
  }
  return pairs;
}

/**
 * The assignments of `set`, in property order.
 *
 * @throws `statement.invalid_values` for an empty or malformed map,
 *   `statement.unknown_column`, and `ColumnValueError` for a refused value.
 */
export function encodeAssignments<T>(codecs: ModelCodecs, set: Values<T>): readonly Assignment[] {
  const pairs = written(codecs, set, 'set');
  if (pairs.length === 0) invalid(codecs, 'set');
  return Object.freeze(
    pairs.map(([column, value]) =>
      Object.freeze({ column: column.column, value: encodeColumn(column, value) }),
    ),
  );
}

/**
 * The columns and encoded rows of `rows`. Every row must write the same
 * properties: a column left out of one row would need the database's
 * default there and a value elsewhere, which one `INSERT` cannot say.
 *
 * @throws `statement.invalid_values` for no rows or rows that differ in
 *   their properties, `statement.unknown_column`, and `ColumnValueError`.
 */
export function encodeInsertRows<T>(codecs: ModelCodecs, rows: readonly Values<T>[]): EncodedRows {
  if (!Array.isArray(rows) || rows.length === 0) invalid(codecs, 'rows');
  let columns: readonly CodecColumn[] | undefined;
  const encoded: SqlValue[][] = [];
  for (const row of rows) {
    const pairs = written(codecs, row, 'rows');
    if (columns === undefined) columns = pairs.map(([column]) => column);
    const byColumn = new Map(pairs);
    if (pairs.length !== columns.length || !columns.every((column) => byColumn.has(column))) {
      invalid(codecs, 'rows');
    }
    encoded.push(columns.map((column) => encodeColumn(column, byColumn.get(column))));
  }
  return Object.freeze({
    columns: Object.freeze((columns ?? []).map((column) => column.column)),
    rows: Object.freeze(encoded.map((row) => Object.freeze(row))),
  });
}
