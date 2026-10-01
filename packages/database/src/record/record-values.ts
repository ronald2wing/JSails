/**
 * What the pipeline reads off a record: the model and data source it belongs
 * to, which of its properties differ from the baseline (the values as loaded
 * or last saved), and the primary-key condition of its baseline. `reload`
 * lives here too: it is the one read of a single record by its own key, and
 * it drops the relations the record held, which the row it reads may no
 * longer name.
 *
 * A write that rolls back puts its record back as it found it
 * (`undoOnRollback`): the state slot, and each column value the write
 * assigned that still holds what the write put there, so a record whose
 * transaction failed saves again as an insert, or with the `lockVersion` its
 * row still has, and a value the caller set afterwards is kept.
 *
 * Two values of a column are the same when they are the same instant, the
 * same bytes, or structurally equal JSON, so a `Date` set to the same
 * instant, or a JSON object rebuilt with the same content, is not a change.
 */

import {
  hydrate,
  persistedState,
  RECORD_STATE,
  recordState,
  setRecordState,
  type RecordState,
} from '../codec/hydrate.js';
import { encodeColumn, type CodecColumn, type ModelCodecs } from '../codec/model-codecs.js';
import type { Predicate } from '../engine/statement.js';
import { modelDefinition } from '../model/define-model.js';
import type { ModelTarget } from '../model/model-spec.js';
import { dataSourceContext, runStatement, type QueryContext } from '../query/query-context.js';
import { and, col, eq, select, table } from '../statement/builders.js';
import { unloadRelations } from '../relation/relation-state.js';
import { modelColumns } from '../statement/where.js';
import { boundDataSource } from './data-source.js';
import { RecordErrors } from './record-errors.js';

/** A record: an instance of a model class, its properties its column values. */
export type RecordObject = Record<string, unknown>;

/** The model and query context of a record. */
export interface RecordTarget {
  readonly model: ModelTarget;
  readonly context: QueryContext;
  readonly codecs: ModelCodecs;
}

/**
 * The model and full query context of `record`, from the data source its
 * class is bound to.
 *
 * @throws `record.not_a_record`, `data_source.not_bound`.
 */
export function targetOf(record: object): RecordTarget {
  const model = (record as { constructor?: unknown }).constructor as ModelTarget | undefined;
  if (model === undefined || modelDefinition(model) === undefined) {
    throw new RecordErrors.Error('not_a_record');
  }
  const context = dataSourceContext(boundDataSource(model));
  return { model, context, codecs: context.catalog.codecs(model) };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether two application values of a column are the same value. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (isJsonObject(a) && isJsonObject(b) && !(a instanceof Date) && !(b instanceof Date)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    );
  }
  return false;
}

/** Set `values` on `record` as plain, enumerable own properties. */
export function assign(record: object, values: Readonly<Record<string, unknown>>): void {
  for (const [property, value] of Object.entries(values)) {
    Object.defineProperty(record, property, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

/**
 * The columns of `record` that differ from `state`'s baseline: every column
 * set to a value other than `undefined` when it is not persisted.
 */
export function changedColumns(
  codecs: ModelCodecs,
  record: object,
  state: RecordState | undefined,
): readonly CodecColumn[] {
  const values = record as RecordObject;
  return codecs.columns.filter((column) => {
    const value = values[column.property];
    if (state === undefined || !state.persisted) return value !== undefined;
    return !sameValue(value, state.baseline[column.property]);
  });
}

/** The properties of `record` that differ from its baseline (every set one when unsaved). */
export function changedProperties(record: object): readonly string[] {
  const { codecs } = targetOf(record);
  return Object.freeze(
    changedColumns(codecs, record, recordState(record)).map((column) => column.property),
  );
}

/** The primary-key condition of a persisted record's baseline. */
export function keyCondition(
  codecs: ModelCodecs,
  baseline: Readonly<Record<string, unknown>>,
): Predicate {
  const terms = codecs.spec.primaryKey.map((property) => {
    const column = codecs.property(property) as CodecColumn;
    return eq(col(codecs.spec.table, column.column), encodeColumn(column, baseline[property]));
  });
  return and(...terms);
}

/** The state of a record that must be saved for `operation`. */
export function persisted(
  record: object,
  codecs: ModelCodecs,
  operation: 'destroyed' | 'reloaded',
): RecordState {
  const state = recordState(record);
  if (state === undefined || !state.persisted) {
    throw new RecordErrors.Error('not_persisted', { model: codecs.spec.name, operation });
  }
  return state;
}

/** Make `record` hold `row` (a full row of its model) and mark it saved. */
export function storeRow(
  record: object,
  codecs: ModelCodecs,
  row: Readonly<Record<string, unknown>>,
): void {
  const fresh = hydrate<RecordObject>(codecs, row as never);
  const stored: Record<string, unknown> = {};
  for (const column of codecs.columns) stored[column.property] = fresh[column.property];
  assign(record, stored);
  setRecordState(record, persistedState(codecs, stored));
}

/**
 * Read `record`'s row again by its baseline key, discarding unsaved changes
 * and the relations it held.
 *
 * @throws `record.not_persisted`, `record.not_found`.
 */
export async function reloadRecord(record: object): Promise<void> {
  const { context, codecs } = targetOf(record);
  const state = persisted(record, codecs, 'reloaded');
  const result = await runStatement(
    context,
    select(table(codecs.spec.table), {
      columns: modelColumns(codecs, codecs.spec.table),
      where: keyCondition(codecs, state.baseline),
      limit: 1,
    }),
  );
  const row = result.rows[0];
  if (row === undefined) throw new RecordErrors.Error('not_found', { model: codecs.spec.name });
  storeRow(record, codecs, row);
  unloadRelations(record, codecs.spec);
}

/** A column value as a record holds it: an own property, or none. */
type Slot = { readonly value: unknown } | undefined;

interface RecordSnapshot {
  readonly state: RecordState | undefined;
  readonly values: ReadonlyMap<string, Slot>;
}

function snapshotRecord(record: object, codecs: ModelCodecs): RecordSnapshot {
  const values = new Map<string, Slot>();
  for (const column of codecs.columns) {
    const { property } = column;
    values.set(
      property,
      Object.hasOwn(record, property) ? { value: (record as RecordObject)[property] } : undefined,
    );
  }
  return { state: recordState(record), values };
}

function sameSlot(a: Slot, b: Slot): boolean {
  return a === undefined || b === undefined ? a === b : Object.is(a.value, b.value);
}

/**
 * Run `mutate`, which changes `record`'s values and state slot as a write
 * does, and return the undo of that change: it restores the state slot and
 * each column the write changed that still holds the write's value.
 */
export function undoOnRollback(
  record: object,
  codecs: ModelCodecs,
  mutate: () => void,
): () => void {
  const before = snapshotRecord(record, codecs);
  mutate();
  const after = snapshotRecord(record, codecs);
  return () => {
    const now = snapshotRecord(record, codecs);
    for (const [property, written] of after.values) {
      const previous = before.values.get(property);
      if (sameSlot(previous, written) || !sameSlot(now.values.get(property), written)) continue;
      if (previous === undefined) Reflect.deleteProperty(record, property);
      else assign(record, { [property]: previous.value });
    }
    if (before.state === undefined) Reflect.deleteProperty(record, RECORD_STATE);
    else setRecordState(record, before.state);
  };
}
