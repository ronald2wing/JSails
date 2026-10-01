/**
 * The owned hydrator: a result row (keyed by physical column name, as the
 * engine returns it) becomes a record whose properties are the decoded
 * application values, with a hidden state slot the write pipeline reads.
 *
 * A record of a `defineModel` class is created with the class's prototype
 * and without running its constructor, so hydration has no side effects; a
 * `defineTable` row becomes a plain object. The state slot lives under
 * `Symbol.for('jsails.record.state')`, non-enumerable, so JSON, spreading
 * and `Object.keys` never see it, and a second copy of this package reads
 * it. It holds:
 *
 * - `persisted`: the record exists in the database;
 * - `baseline`: the values as loaded, frozen and deep-copied, so changing a
 *   `Date`, bytes or JSON value of the record in place cannot change what
 *   the change set compares against;
 * - `fks`: for each owning (`belongsTo`) relation, its foreign key as
 *   loaded: the key value, or `{ type, id }` for a polymorphic one, which is
 *   what a relation load groups by.
 *
 * {@link decodeRow} is the projection form: a frozen plain object of the
 * selected columns with no state slot, never a partial record.
 */

import type { Row } from '../engine/contract.js';
import type { JsonValue } from '../model/portable-type.js';
import { CodecErrors, reportedName } from './codec-errors.js';
import { decodeColumn, type CodecColumn, type ModelCodecs } from './model-codecs.js';

/** The symbol a record's {@link RecordState} is kept under. */
export const RECORD_STATE: unique symbol = Symbol.for('jsails.record.state') as never;

/** The foreign key of one polymorphic `belongsTo` relation. */
export interface PolymorphicKey {
  readonly type: string | null;
  readonly id: unknown;
}

/** What a record knows about itself beyond its properties. */
export interface RecordState {
  readonly persisted: boolean;
  /** Property values as last loaded or saved. */
  readonly baseline: Readonly<Record<string, unknown>>;
  /**
   * The foreign key of each `belongsTo` relation, by relation name: the key
   * value, or a {@link PolymorphicKey}.
   */
  readonly fks: Readonly<Record<string, unknown>>;
}

/** An independent, frozen copy of an application value. */
function snapshot(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return value.slice();
  if (value !== null && typeof value === 'object') return deepFreeze(structuredClone(value));
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, JsonValue>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function readColumn(codecs: ModelCodecs, column: CodecColumn, row: Row): unknown {
  if (!Object.hasOwn(row, column.column)) {
    throw new CodecErrors.Error('incomplete_row', {
      model: codecs.spec.name,
      column: column.column,
    });
  }
  return decodeColumn(column, row[column.column]);
}

/** The loaded foreign keys of every `belongsTo` relation of a decoded record. */
function foreignKeys(
  codecs: ModelCodecs,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const fks: Record<string, unknown> = {};
  const polymorphic: Record<string, { type: string | null; id: unknown }> = {};
  for (const column of codecs.spec.columns) {
    const relation = column.relation;
    if (relation === undefined) continue;
    const value = values[column.property];
    if (column.origin === 'foreign-key') fks[relation] = value;
    else if (column.origin === 'polymorphic-type') {
      (polymorphic[relation] ??= { type: null, id: null }).type = value as string | null;
    } else if (column.origin === 'polymorphic-id') {
      (polymorphic[relation] ??= { type: null, id: null }).id = value;
    }
  }
  for (const [relation, pair] of Object.entries(polymorphic)) {
    fks[relation] = Object.freeze(pair satisfies PolymorphicKey);
  }
  return fks;
}

/** A frozen state slot. */
export function createRecordState(state: RecordState): RecordState {
  const baseline: Record<string, unknown> = {};
  for (const [property, value] of Object.entries(state.baseline)) {
    baseline[property] = snapshot(value);
  }
  return Object.freeze({
    persisted: state.persisted,
    baseline: Object.freeze(baseline),
    fks: Object.freeze({ ...state.fks }),
  });
}

/**
 * The state of a record of `codecs`' model whose stored values are `values`
 * (by property): persisted, with them as its baseline and its foreign keys
 * read from them. A record write sets it after a save.
 */
export function persistedState(
  codecs: ModelCodecs,
  values: Readonly<Record<string, unknown>>,
): RecordState {
  return createRecordState({ persisted: true, baseline: values, fks: foreignKeys(codecs, values) });
}

/** Set `record`'s state slot; the write pipeline calls it after a save. */
export function setRecordState(record: object, state: RecordState): void {
  Object.defineProperty(record, RECORD_STATE, {
    value: createRecordState(state),
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

/** `record`'s state slot, or `undefined` for an object the hydrator never saw. */
export function recordState(record: object): RecordState | undefined {
  const state = (record as { [RECORD_STATE]?: RecordState })[RECORD_STATE];
  return Object.hasOwn(record, RECORD_STATE) ? state : undefined;
}

/**
 * The record of a full row of the model: an instance of the model class (a
 * plain object for a table) with every column decoded and a persisted state
 * slot.
 *
 * @throws `codec.incomplete_row` when the row lacks a model column, and
 *   `ColumnValueError` for a stored value a codec refuses.
 */
export function hydrate<T extends object = Record<string, unknown>>(
  codecs: ModelCodecs,
  row: Row,
): T {
  const values: Record<string, unknown> = {};
  for (const column of codecs.columns) values[column.property] = readColumn(codecs, column, row);
  const record: Record<string, unknown> =
    typeof codecs.target === 'function'
      ? (Object.create((codecs.target as { prototype: object }).prototype) as Record<
          string,
          unknown
        >)
      : {};
  for (const [property, value] of Object.entries(values)) {
    Object.defineProperty(record, property, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  setRecordState(record, persistedState(codecs, values));
  return record as T;
}

/**
 * The decoded projection of `row`: a frozen plain object of `properties`
 * (every column when unset), with no state slot.
 *
 * @throws `codec.unknown_property` for a property the model does not have,
 *   and `codec.incomplete_row` when the row lacks a selected column.
 */
export function decodeRow(
  codecs: ModelCodecs,
  row: Row,
  properties?: readonly string[],
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const columns =
    properties === undefined
      ? codecs.columns
      : properties.map((property) => {
          const column = codecs.property(property);
          if (column === undefined) {
            throw new CodecErrors.Error('unknown_property', {
              model: codecs.spec.name,
              field: reportedName(property),
            });
          }
          return column;
        });
  for (const column of columns) result[column.property] = readColumn(codecs, column, row);
  return Object.freeze(result);
}
