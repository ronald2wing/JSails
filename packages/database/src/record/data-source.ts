/**
 * `JsailsDataSource`: one database and the models that live in it. It holds
 * the engine privately and opens it on first use, so constructing one never
 * connects (opening the `database()` plugin's substrate resource constructs
 * one and connects nothing until the first statement), and it builds the
 * statement catalog every query and record write compiles against. Nothing
 * it exposes hands out the engine: app code reaches SQL through the guarded
 * compile, a transaction through `transaction(ds, ...)`, and raw SQL only
 * through `@jsails/database/unguarded`.
 *
 * Constructing a data source binds each of its models to it: `Post.where`,
 * `query(PostTag)` and a record's `save()` find their data source through
 * that binding. A model bound to a data source that is still open cannot be
 * bound again (`data_source.already_bound`, and nothing of the second data
 * source is bound); `close()` unbinds. The binding table lives on
 * `globalThis` under a `Symbol.for` key, so class-less `defineTable` targets,
 * which are frozen, can be bound as well, and a duplicate copy of this
 * package sees the same bindings: a model stays bound to one open data source
 * in the process. A data source's internals belong to the copy that made it,
 * so the other copy refuses it, by the mark it carries
 * (`data-source-mark.ts`), as `data_source.duplicate_package`.
 */

import { createChangeFeed, type ChangeEmitter, type ChangeFeed } from '../change/change-feed.js';
import type { DatabaseConfig } from '../engine/config.js';
import type { Dialect, Engine } from '../engine/contract.js';
import { createEngine } from '../engine/create-engine.js';
import type { ConnectionErrorListener } from '../engine/server/server-engine.js';
import type { SealProvider } from '../codec/seal-provider.js';
import { modelDefinition } from '../model/define-model.js';
import type { ModelTarget } from '../model/model-spec.js';
import { createStatementCatalog, type StatementCatalog } from '../statement/statement-catalog.js';
import { registerEngineSource } from '../transaction/engine-source.js';
import {
  transaction,
  withTestTransaction,
  type Tx,
  type TransactionRunOptions,
} from '../transaction/run-transaction.js';
import { attachmentTable } from './attachment-table.js';
import type { AttachmentOptions } from './attachments.js';
import { duplicatePackage, isMarkedDataSource, markDataSource } from './data-source-mark.js';
import { DataSourceErrors } from './record-errors.js';

/** What a {@link JsailsDataSource} is constructed with. */
export interface JsailsDataSourceOptions {
  /** The resolved database configuration (`resolveDatabaseConfig`). */
  readonly config: DatabaseConfig;
  /** Every model and link table the data source reads or writes; each is bound to it. */
  readonly models: readonly ModelTarget[];
  /** Builds the seal layer of encrypted columns (the encryption keyring). */
  readonly seal?: SealProvider;
  /** Receives failures of pooled connections no caller holds. */
  readonly onConnectionError?: ConnectionErrorListener;
  /**
   * Where attachment blobs live, and where a failed blob cleanup is
   * reported; required when a model declares attachments, which also needs
   * `attachmentTable` in `models`.
   */
  readonly attachments?: AttachmentOptions;
}

/** What the rest of the package reads from a data source; never exported by a barrel. */
export interface DataSourceInternals {
  readonly catalog: StatementCatalog;
  /** The write side of {@link JsailsDataSource.changes}. */
  readonly changes: ChangeEmitter;
  /** The attachment options, when the data source was given them. */
  readonly attachments: AttachmentOptions | undefined;
  /** The engine, opened on first use. */
  engine(): Promise<Engine>;
  /** Throw `data_source.closed` when the data source is closed. */
  assertOpen(): void;
}

const INTERNALS = new WeakMap<JsailsDataSource, DataSourceInternals>();

const BINDINGS_KEY = Symbol.for('jsails.database.modelBindings.v1');
const holder = globalThis as unknown as Record<
  symbol,
  WeakMap<object, JsailsDataSource> | undefined
>;

function bindings(): WeakMap<object, JsailsDataSource> {
  let table = holder[BINDINGS_KEY];
  if (table === undefined) {
    table = new WeakMap();
    Object.defineProperty(globalThis, BINDINGS_KEY, { value: table, enumerable: false });
  }
  return table;
}

/** The model name of `target` for an error context. */
export function modelName(target: ModelTarget): string {
  const definition = modelDefinition(target);
  if (definition === undefined) throw new DataSourceErrors.Error('not_a_model');
  return definition.spec.name;
}

/** The attachment options of `options`, checked against the models' attachments. */
function checkAttachments(options: JsailsDataSourceOptions): AttachmentOptions | undefined {
  const { attachments } = options;
  if (attachments !== undefined) {
    if (
      attachments === null ||
      typeof attachments !== 'object' ||
      attachments.disk === null ||
      typeof attachments.disk !== 'object' ||
      typeof attachments.disk.delete !== 'function' ||
      typeof attachments.onCleanupError !== 'function'
    ) {
      throw new DataSourceErrors.Error('invalid_options', { field: 'attachments' });
    }
  }
  const declared = options.models.some(
    (model) => Object.keys(modelDefinition(model)?.spec.attachments ?? {}).length > 0,
  );
  if (declared && (attachments === undefined || !options.models.includes(attachmentTable))) {
    throw new DataSourceErrors.Error('invalid_options', { field: 'attachments' });
  }
  return attachments === undefined
    ? undefined
    : Object.freeze({ disk: attachments.disk, onCleanupError: attachments.onCleanupError });
}

/** A database and its models. */
export class JsailsDataSource {
  readonly dialect: Dialect;
  /** The models bound to this data source, in the order given. */
  readonly models: readonly ModelTarget[];
  /** Key-only records of the writes committed through this data source (`change-feed.ts`). */
  readonly changes: ChangeFeed;
  #closed = false;
  #closing: Promise<void> | undefined;
  #engine: Promise<Engine> | undefined;
  /** The engine once {@link #engine} fulfilled, for callers that must not wait a turn. */
  #opened: Engine | undefined;

  /**
   * Bind `options.models` to a new data source on `options.config`. Nothing
   * connects until the first statement.
   *
   * @throws `data_source.invalid_options` (`attachments` when they lack a
   *   disk or `onCleanupError`, or a model declares attachments without them
   *   or without `attachmentTable` in `models`), `data_source.not_a_model`,
   *   `data_source.already_bound` for a model bound to an open data source,
   *   and the catalog's `statement.duplicate_table`.
   */
  constructor(options: JsailsDataSourceOptions) {
    if (options === null || typeof options !== 'object') {
      throw new DataSourceErrors.Error('invalid_options', { field: 'options' });
    }
    const { config, seal, onConnectionError } = options;
    if (config === null || typeof config !== 'object' || typeof config.dialect !== 'string') {
      throw new DataSourceErrors.Error('invalid_options', { field: 'config' });
    }
    if (!Array.isArray(options.models)) {
      throw new DataSourceErrors.Error('invalid_options', { field: 'models' });
    }
    for (const model of options.models) modelName(model);
    const attachments = checkAttachments(options);
    const catalog = createStatementCatalog({
      dialect: config.dialect,
      models: options.models,
      ...(seal === undefined ? {} : { seal }),
    });
    const table = bindings();
    for (const model of catalog.models) {
      const bound = table.get(model);
      if (bound !== undefined && !bound.closed) {
        throw new DataSourceErrors.Error('already_bound', { model: modelName(model) });
      }
    }
    this.dialect = config.dialect;
    this.models = catalog.models;
    const { feed, emitter } = createChangeFeed();
    this.changes = feed;
    markDataSource(this);
    for (const model of catalog.models) table.set(model, this);
    registerEngineSource(this, () => {
      if (this.#closed) return Promise.reject(new DataSourceErrors.Error('closed'));
      return this.#opened ?? this.#openEngine(config, onConnectionError);
    });
    INTERNALS.set(this, {
      catalog,
      changes: emitter,
      attachments,
      engine: () => this.#openEngine(config, onConnectionError),
      assertOpen: () => {
        if (this.#closed) throw new DataSourceErrors.Error('closed');
      },
    });
  }

  /** Whether {@link close} was called. */
  get closed(): boolean {
    return this.#closed;
  }

  #openEngine(
    config: DatabaseConfig,
    onConnectionError: ConnectionErrorListener | undefined,
  ): Promise<Engine> {
    if (this.#closed) return Promise.reject(new DataSourceErrors.Error('closed'));
    if (this.#engine === undefined) {
      const opening = createEngine(
        config,
        onConnectionError === undefined ? {} : { onConnectionError },
      );
      this.#engine = opening;
      opening.then(
        (engine) => {
          if (this.#engine === opening) this.#opened = engine;
        },
        // A failed open is not kept: the next statement tries again.
        () => {
          if (this.#engine === opening) this.#engine = undefined;
        },
      );
    }
    return this.#engine;
  }

  /** Run `body` in a transaction on this data source (see `transaction()`). */
  transaction<R>(body: (tx: Tx) => R | Promise<R>, options?: TransactionRunOptions): Promise<R> {
    return transaction(this, body, options);
  }

  /** Run `body` in a transaction that always rolls back (see `withTestTransaction()`). */
  withTestTransaction<R>(body: () => R | Promise<R>): Promise<R> {
    return withTestTransaction(this, body);
  }

  /**
   * Unbind every model and close the engine, if it was opened. Statements
   * still waiting are rejected; every later use fails with
   * `data_source.closed`. Closing twice returns the first close.
   */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    const table = bindings();
    for (const model of this.models) {
      if (table.get(model) === this) table.delete(model);
    }
    const opening = this.#engine;
    this.#engine = undefined;
    this.#opened = undefined;
    this.#closing =
      opening === undefined
        ? Promise.resolve()
        : opening.then(
            (engine) => engine.close(),
            // An engine that never opened holds nothing to close.
            () => undefined,
          );
    return this.#closing;
  }
}

/**
 * The package-internal view of `dataSource`.
 *
 * @throws `data_source.duplicate_package` for a data source of another copy
 *   of this package, `data_source.invalid_options` for anything else.
 */
export function internalsOf(dataSource: JsailsDataSource): DataSourceInternals {
  const internals = INTERNALS.get(dataSource);
  if (internals === undefined) {
    if (isMarkedDataSource(dataSource)) throw duplicatePackage();
    throw new DataSourceErrors.Error('invalid_options', { field: 'dataSource' });
  }
  return internals;
}

/**
 * The open data source `model` is bound to.
 *
 * @throws `data_source.not_a_model`, `data_source.not_bound`, and
 *   `data_source.duplicate_package` when another copy of this package bound
 *   it.
 */
export function boundDataSource(model: ModelTarget): JsailsDataSource {
  const name = modelName(model);
  const bound = bindings().get(model);
  if (bound === undefined || bound.closed) {
    throw new DataSourceErrors.Error('not_bound', { model: name });
  }
  if (!INTERNALS.has(bound)) throw duplicatePackage();
  return bound;
}
