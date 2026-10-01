/**
 * A model-set handle: the data access a gated plugin is given instead of the
 * data source. It is bound to the models the plugin owns plus the models it
 * was granted read access to, and its statements compile against a catalog
 * that knows only those tables, so a relation filter or subquery reaching
 * any other table is refused (`statement.unknown_table`) before SQL exists.
 *
 * - An owned model (`models`): queries return records, set writes and
 *   inserts are allowed.
 * - A read grant (`read`): `read(model)` returns frozen plain rows, never
 *   records, so nothing read through a grant can be saved back through the
 *   model's binding; writes and row locks are refused
 *   (`data_source.not_granted`).
 *
 * Every model must be bound to the data source the handle is made from.
 */

import type { ModelTarget } from '../model/model-spec.js';
import { ModelQuery } from '../query/model-query.js';
import { handleContexts, restrictCatalog, type WriteResult } from '../query/query-context.js';
import type { Values } from '../statement/model-values.js';
import type { StatementCatalog } from '../statement/statement-catalog.js';
import type { Tx, TransactionRunOptions } from '../transaction/run-transaction.js';
import { internalsOf, modelName, type JsailsDataSource } from './data-source.js';
import { DataSourceErrors } from './record-errors.js';
import { insertRows, type SetWriteOptions } from './set-writes.js';

/** What a model-set handle is granted. */
export interface DataHandleOptions {
  /** Models the holder owns: read and write. */
  readonly models: readonly ModelTarget[];
  /** Models the holder may read, as plain rows. */
  readonly read?: readonly ModelTarget[];
}

/** A class model, as the handle's methods take it. */
type ModelConstructor = abstract new (...args: never[]) => object;

/** Data access restricted to a set of models. */
export interface DataHandle {
  /** A query of an owned model, returning records. */
  query<M extends ModelConstructor>(model: M): ModelQuery<InstanceType<M>>;
  query<T extends object = Record<string, unknown>>(model: ModelTarget): ModelQuery<T>;
  /** A query of an owned or granted model, returning frozen plain rows. */
  read<M extends ModelConstructor>(
    model: M,
  ): ModelQuery<InstanceType<M>, Readonly<InstanceType<M>>>;
  read<T extends object = Record<string, unknown>>(model: ModelTarget): ModelQuery<T, Readonly<T>>;
  /** Insert rows of an owned model (a set write; see `ModelQuery.updateAll`). */
  insertAll<T extends object = Record<string, unknown>>(
    model: ModelTarget,
    rows: readonly Values<T>[],
    options?: SetWriteOptions,
  ): Promise<WriteResult>;
  /** Run `body` in a transaction on the handle's data source. */
  transaction<R>(body: (tx: Tx) => R | Promise<R>, options?: TransactionRunOptions): Promise<R>;
}

function modelList(value: unknown, field: string): readonly ModelTarget[] {
  if (value === undefined && field === 'read') return [];
  if (!Array.isArray(value)) throw new DataSourceErrors.Error('invalid_options', { field });
  return value as readonly ModelTarget[];
}

/**
 * A handle on `dataSource` restricted to `options.models` and the read
 * grants `options.read`.
 *
 * @throws `data_source.invalid_options`, `data_source.not_a_model`,
 *   `data_source.not_bound` for a model of another data source, and
 *   `data_source.closed`.
 */
export function dataHandle(dataSource: JsailsDataSource, options: DataHandleOptions): DataHandle {
  const internals = internalsOf(dataSource);
  internals.assertOpen();
  if (options === null || typeof options !== 'object') {
    throw new DataSourceErrors.Error('invalid_options', { field: 'options' });
  }
  const owned = new Set(modelList(options.models, 'models'));
  const granted = new Set(modelList(options.read, 'read'));
  const bound = new Set(dataSource.models);
  for (const model of [...owned, ...granted]) {
    const name = modelName(model);
    if (!bound.has(model)) throw new DataSourceErrors.Error('not_bound', { model: name });
  }
  const catalog: StatementCatalog = restrictCatalog(internals.catalog, [...owned, ...granted]);
  const { owned: ownedContext, read: readContext } = handleContexts(dataSource, catalog, owned);
  const requireOwned = (model: ModelTarget): void => {
    if (!owned.has(model)) {
      throw new DataSourceErrors.Error('not_granted', { model: modelName(model), access: 'write' });
    }
  };
  return Object.freeze({
    query: (model: ModelTarget) => {
      requireOwned(model);
      return new ModelQuery(ownedContext, catalog.codecs(model));
    },
    read: (model: ModelTarget) => {
      if (!owned.has(model) && !granted.has(model)) {
        throw new DataSourceErrors.Error('not_granted', {
          model: modelName(model),
          access: 'read',
        });
      }
      return new ModelQuery(readContext, catalog.codecs(model));
    },
    insertAll: async (
      model: ModelTarget,
      rows: readonly Values<object>[],
      writeOptions?: SetWriteOptions,
    ) => {
      requireOwned(model);
      return insertRows(ownedContext, catalog.codecs(model), rows, writeOptions);
    },
    transaction: <R>(body: (tx: Tx) => R | Promise<R>, runOptions?: TransactionRunOptions) =>
      dataSource.transaction(body, runOptions),
  }) as DataHandle;
}
