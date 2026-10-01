/**
 * `ApplicationRecord`: the base class of a model's records. It extends
 * nothing (no ORM entity), and holds no state of its own beyond the hidden
 * record state the hydrator and the record writes keep.
 *
 * ```ts
 * class Post extends ApplicationRecord {
 *   declare id: number;
 *   declare title: string;
 * }
 * defineModel(Post, { table: 'posts', columns: { title: column.string(200) } });
 *
 * const post = await Post.find(1);
 * post.title = 'Renamed';
 * await post.save();
 * const live = await Post.where({ status: 'live' }).orderBy('id').getMany();
 * ```
 *
 * The statics run on the data source the model is bound to: `find`,
 * `findBy`, `where`, `all`, `build`, `create` and `insertAll`. The instance
 * methods are `save`, `destroy`, `reload`, `isPersisted`, `changed` and
 * `was`. A record's column properties are plain own properties, so JSON and
 * spreading see exactly its values, and the relations it holds (loaded or
 * assigned); a relation it does not hold is an accessor of the class that
 * throws `relation.not_loaded`, never `undefined` or empty.
 */

import { recordState } from '../codec/hydrate.js';
import { insertAll as insertModelRows, query, type ModelQuery } from '../query/model-query.js';
import type { WriteResult } from '../query/query-context.js';
import type { Values } from '../statement/model-values.js';
import type { ColumnKey, WhereInput } from '../statement/where.js';
import { modelDefinition } from '../model/define-model.js';
import type { ModelTarget } from '../model/model-spec.js';
import { RecordErrors } from './record-errors.js';
import { destroyRecord, saveRecord } from './pipeline.js';
import { changedProperties, reloadRecord } from './record-values.js';
import type { SetWriteOptions } from './set-writes.js';

/** A model class whose records are `M`, as the statics take `this`. */
export type RecordClass<M extends ApplicationRecord> = abstract new (...args: never[]) => M;

/**
 * A primary-key value: the key itself, or an object naming every column of a
 * composite key.
 */
export type RecordKey = string | number | bigint | Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function definitionOf(model: object): NonNullable<ReturnType<typeof modelDefinition>> {
  const definition = modelDefinition(model);
  if (definition === undefined) throw new RecordErrors.Error('not_a_record');
  return definition;
}

/** The `Where` that names exactly the primary key `key`. */
function keyWhere(model: object, key: RecordKey): Readonly<Record<string, unknown>> {
  const { spec } = definitionOf(model);
  const invalid = (): never => {
    throw new RecordErrors.Error('invalid_key', { model: spec.name });
  };
  const primaryKey = spec.primaryKey;
  if (primaryKey.length === 1) {
    if (key === null || key === undefined || isPlainObject(key)) return invalid();
    return { [primaryKey[0] as string]: key };
  }
  if (!isPlainObject(key)) return invalid();
  const keys = Object.keys(key);
  if (
    keys.length !== primaryKey.length ||
    !primaryKey.every((property) => Object.hasOwn(key, property))
  ) {
    return invalid();
  }
  for (const property of primaryKey) {
    const value = key[property];
    if (value === null || value === undefined || isPlainObject(value)) return invalid();
  }
  return key;
}

/** A query of `model`'s records, typed by the record type the statics infer. */
function recordsOf<M extends ApplicationRecord>(model: RecordClass<M>): ModelQuery<M> {
  return query<M>(model as ModelTarget);
}

/** The base class of model records. */
export class ApplicationRecord {
  /**
   * The record with primary key `key` (an object naming each column of a
   * composite key).
   *
   * @throws `record.not_found` when there is none, `record.invalid_key`.
   */
  static async find<M extends ApplicationRecord>(this: RecordClass<M>, key: RecordKey): Promise<M> {
    const found = await recordsOf(this)
      .where(keyWhere(this, key) as WhereInput<M>)
      .getOne();
    if (found === null) {
      throw new RecordErrors.Error('not_found', { model: definitionOf(this).spec.name });
    }
    return found;
  }

  /** The first record matching `where`, or `null`. */
  static findBy<M extends ApplicationRecord>(
    this: RecordClass<M>,
    where: WhereInput<M>,
  ): Promise<M | null> {
    return recordsOf(this).where(where).getOne();
  }

  /** A query of the records matching `where`. */
  static where<M extends ApplicationRecord>(
    this: RecordClass<M>,
    where: WhereInput<M>,
  ): ModelQuery<M> {
    return recordsOf(this).where(where);
  }

  /** A query of every record. */
  static all<M extends ApplicationRecord>(this: RecordClass<M>): ModelQuery<M> {
    return recordsOf(this);
  }

  /** A new, unsaved record with `values`. The class constructor runs with no arguments. */
  static build<M extends ApplicationRecord>(this: RecordClass<M>, values: Values<M> = {}): M {
    definitionOf(this);
    const record = Reflect.construct(this, []) as M;
    for (const [property, value] of Object.entries(values)) {
      if (value === undefined) continue;
      Object.defineProperty(record, property, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return record;
  }

  /** Build a record with `values` and save it. */
  static async create<M extends ApplicationRecord>(
    this: RecordClass<M>,
    values: Values<M> = {},
  ): Promise<M> {
    const record = ApplicationRecord.build.call(this, values) as M;
    await record.save();
    return record;
  }

  /**
   * Insert `rows` in as few statements as the bind limit allows, all in one
   * transaction. A set write: no hooks or validation run per row (a model
   * that declares them needs `{ skipHooks: true }`), and the model's
   * counter caches and touches run in set form.
   *
   * @throws `query.set_write_skips_hooks`.
   */
  static insertAll<M extends ApplicationRecord>(
    this: RecordClass<M>,
    rows: readonly Values<M>[],
    options?: SetWriteOptions,
  ): Promise<WriteResult> {
    return insertModelRows<M>(this, rows, options);
  }

  /**
   * Insert the record when it is not saved, or update its changed columns,
   * through the write pipeline: hooks, validation, declared effects and
   * change records, atomically (`pipeline.ts`). A save with nothing to write
   * does nothing.
   *
   * @throws `record.invalid` when validation fails, `record.stale_record`
   *   when an update matches no row.
   */
  async save(): Promise<this> {
    await saveRecord(this);
    return this;
  }

  /**
   * Delete the record's row, with its dependents and attachments, through the
   * write pipeline; the record is unsaved afterwards.
   *
   * @throws `record.not_persisted`, `record.stale_record`.
   */
  async destroy(): Promise<void> {
    await destroyRecord(this);
  }

  /**
   * Read the record's row again, discarding unsaved changes; the relations it
   * held read as not loaded again.
   *
   * @throws `record.not_persisted`, `record.not_found`.
   */
  async reload(): Promise<this> {
    await reloadRecord(this);
    return this;
  }

  /** Whether the record's row exists (it was loaded or saved, and not destroyed). */
  isPersisted(): boolean {
    return recordState(this)?.persisted === true;
  }

  /** The properties changed since the record was loaded or saved (every set one when unsaved). */
  changed(): readonly ColumnKey<this>[] {
    return changedProperties(this) as readonly ColumnKey<this>[];
  }

  /** The value `property` had when the record was loaded or saved; `undefined` when unsaved. */
  was<K extends ColumnKey<this>>(property: K): this[K] | undefined {
    const state = recordState(this);
    if (state === undefined || !state.persisted) return undefined;
    return state.baseline[property] as this[K] | undefined;
  }
}
