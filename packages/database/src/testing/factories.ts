/**
 * Factories: records with generated values. `defineFactory(Model, generator)`
 * pairs a record class with a function from a sequence number to values;
 * the factory builds, creates and inserts records with them, overrides
 * winning over generated values.
 *
 * A factory is a thin layer over the model's own API, so its records behave
 * like the app's: `build` is `Model.build` (unsaved), `create` is
 * `Model.create` (the write pipeline, with hooks, validation, effects and
 * change records), `createList` runs its creates in one `transaction()`,
 * and `insertAll` is `Model.insertAll` (a set write, so a model with hooks
 * needs `{ skipHooks: true }`). Everything joins the ambient transaction,
 * and rolls back with a test transaction.
 *
 * The sequence counts up across every call of one factory and is never
 * reset, so two records of one test never get the same generated unique
 * value. A record with associations takes them as overrides (a foreign key)
 * or as an assigned autosave relation after `build`.
 */

import type { WriteResult } from '../query/query-context.js';
import { ApplicationRecord, type RecordClass } from '../record/application-record.js';
import { boundDataSource } from '../record/data-source.js';
import type { SetWriteOptions } from '../record/set-writes.js';
import { modelDefinition } from '../model/define-model.js';
import type { Values } from '../statement/model-values.js';
import { transaction } from '../transaction/run-transaction.js';
import { TestingErrors } from './testing-errors.js';

/** The values of the record at `sequence` (1 for the factory's first record). */
export type FactoryGenerator<M> = (sequence: number) => Values<M>;

/** Records of one model with generated values; see {@link defineFactory}. */
export interface Factory<M extends ApplicationRecord> {
  readonly model: RecordClass<M>;
  /** An unsaved record with the next generated values and `overrides`. */
  build(overrides?: Values<M>): M;
  /** `count` unsaved records. */
  buildList(count: number, overrides?: Values<M>): M[];
  /** A record created through the write pipeline (`Model.create`). */
  create(overrides?: Values<M>): Promise<M>;
  /** `count` records created through the write pipeline, in one transaction. */
  createList(count: number, overrides?: Values<M>): Promise<M[]>;
  /** `count` rows inserted as one set write (`Model.insertAll`). */
  insertAll(count: number, overrides?: Values<M>, options?: SetWriteOptions): Promise<WriteResult>;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkCount(count: unknown): number {
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new TestingErrors.Error('invalid_factory', { field: 'count' });
  }
  return count as number;
}

function checkOverrides<M>(overrides: unknown): Values<M> {
  if (overrides === undefined) return {};
  if (!isPlainObject(overrides)) {
    throw new TestingErrors.Error('invalid_factory', { field: 'overrides' });
  }
  return overrides as Values<M>;
}

/**
 * A factory of `model`'s records, with values from `generator`.
 *
 * ```ts
 * const users = defineFactory(User, (n) => ({ email: `user${n}@example.test`, name: `User ${n}` }));
 * const ada = await users.create({ name: 'Ada' });
 * const drafts = users.buildList(3);
 * ```
 *
 * @throws `testing.invalid_factory` for a model that is not a record class
 *   defined with `defineModel`, or a generator that is not a function. Its
 *   methods throw it for a bad count, overrides, or a generator that returns
 *   something other than a plain object.
 */
export function defineFactory<M extends ApplicationRecord>(
  model: RecordClass<M>,
  generator: FactoryGenerator<M>,
): Factory<M> {
  if (
    typeof model !== 'function' ||
    modelDefinition(model)?.kind !== 'model' ||
    !((model as { readonly prototype?: unknown }).prototype instanceof ApplicationRecord)
  ) {
    throw new TestingErrors.Error('invalid_factory', { field: 'model' });
  }
  if (typeof generator !== 'function') {
    throw new TestingErrors.Error('invalid_factory', { field: 'generator' });
  }
  let sequence = 0;

  const values = (overrides: unknown): Values<M> => {
    const checked = checkOverrides<M>(overrides);
    sequence += 1;
    const generated: unknown = generator(sequence);
    if (!isPlainObject(generated)) {
      throw new TestingErrors.Error('invalid_factory', { field: 'generator' });
    }
    return { ...(generated as Values<M>), ...checked };
  };
  const build = (overrides?: Values<M>): M =>
    ApplicationRecord.build.call(model, values(overrides)) as M;
  const create = (overrides?: Values<M>): Promise<M> =>
    ApplicationRecord.create.call(model, values(overrides)) as Promise<M>;

  return Object.freeze({
    model,
    build,
    buildList(count: number, overrides?: Values<M>): M[] {
      return Array.from({ length: checkCount(count) }, () => build(overrides));
    },
    create,
    async createList(count: number, overrides?: Values<M>): Promise<M[]> {
      const total = checkCount(count);
      checkOverrides(overrides);
      return transaction(boundDataSource(model), async () => {
        const created: M[] = [];
        for (let index = 0; index < total; index += 1) created.push(await create(overrides));
        return created;
      });
    },
    async insertAll(
      count: number,
      overrides?: Values<M>,
      options?: SetWriteOptions,
    ): Promise<WriteResult> {
      const rows = Array.from({ length: checkCount(count) }, () => values(overrides));
      // `Model.insertAll` refuses no rows; a factory asked for none inserts none.
      if (rows.length === 0) return Object.freeze({ affected: 0 });
      return ApplicationRecord.insertAll.call(model, rows, options);
    },
  });
}
