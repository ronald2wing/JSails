/**
 * What a query runs against, and how its statements run: the data source,
 * the catalog its statements compile against (the data source's own, or a
 * model-set handle's narrower one), and whether its rows come back as
 * records and may be written.
 *
 * The catalog decides the tenant policy and the tables a statement may name,
 * and `writable` decides whether it may write, so a context is made only
 * here (`dataSourceContext`, `handleContexts`) and a `ModelQuery` or a
 * statement given any other object is refused (`query.invalid_context`): a
 * caller cannot pair a data source with a catalog of its own and reach its
 * engine around the tenant policy or a handle's grants.
 *
 * Statements run on a lease of the data source's engine (inside a
 * transaction, a view of the transaction's connection): a query and the
 * relation loads of its records hold one lease between them (`withLease`),
 * a lone statement holds one for its own duration (`runStatement`). Each goes
 * through the guarded compile under the ambient tenant scope, or with the
 * scope off for a query that opted out. Writes go through the record
 * pipeline (`record/pipeline.ts`, `record/set-writes.ts`), which runs its
 * statements here.
 */

import type { ModelCodecs } from '../codec/model-codecs.js';
import type { QueryResult } from '../engine/contract.js';
import type { Statement } from '../engine/statement.js';
import { modelDefinition } from '../model/define-model.js';
import type { ModelTarget } from '../model/model-spec.js';
import { executeStatement } from '../statement/guarded-compile.js';
import type { StatementCatalog } from '../statement/statement-catalog.js';
import { StatementErrors } from '../statement/statement-errors.js';
import { withoutTenantScope } from '../statement/tenant-scope.js';
import { internalsOf, type JsailsDataSource } from '../record/data-source.js';
import { QueryErrors } from './query-errors.js';

/** What a query runs against; made only by this package. */
export interface QueryContext {
  readonly dataSource: JsailsDataSource;
  readonly catalog: StatementCatalog;
  /** Rows come back as records (`true`) or as frozen plain rows. */
  readonly records: boolean;
  /** Set writes and inserts are allowed. */
  readonly writable: boolean;
  /**
   * The models whose rows may come back as records, when not every model of
   * the catalog may: a data handle's owned models. A relation load refuses
   * any other target, since a record of a read grant could be saved back.
   */
  readonly recordModels?: ReadonlySet<ModelTarget>;
}

/** What a set write or insert changed. */
export interface WriteResult {
  /** Rows inserted, deleted, or matched by an update (whether or not a value changed). */
  readonly affected: number;
}

/** Every context this module made; nothing else runs a statement. */
const CONTEXTS = new WeakSet<QueryContext>();

/** The full context of each data source, made once. */
const FULL_CONTEXTS = new WeakMap<JsailsDataSource, QueryContext>();

function mint(context: QueryContext): QueryContext {
  const frozen = Object.freeze({ ...context });
  CONTEXTS.add(frozen);
  return frozen;
}

/** The full context of `dataSource`: its own catalog, records, writable. */
export function dataSourceContext(dataSource: JsailsDataSource): QueryContext {
  let context = FULL_CONTEXTS.get(dataSource);
  if (context === undefined) {
    const { catalog } = internalsOf(dataSource);
    context = mint({ dataSource, catalog, records: true, writable: true });
    FULL_CONTEXTS.set(dataSource, context);
  }
  return context;
}

/**
 * The two contexts of a model-set handle over `catalog`: its owned models
 * (`owned`, the only ones read as records), and its read grants.
 */
export function handleContexts(
  dataSource: JsailsDataSource,
  catalog: StatementCatalog,
  owned: ReadonlySet<ModelTarget>,
): { readonly owned: QueryContext; readonly read: QueryContext } {
  internalsOf(dataSource);
  const recordModels: ReadonlySet<ModelTarget> = new Set(owned);
  return Object.freeze({
    owned: mint({ dataSource, catalog, records: true, writable: true, recordModels }),
    read: mint({ dataSource, catalog, records: false, writable: false }),
  });
}

/**
 * Refuse a context this module did not make, and codecs that are not its
 * catalog's own for their table.
 *
 * @throws `query.invalid_context`.
 */
export function assertQuerySource(context: QueryContext, codecs?: ModelCodecs): void {
  if (!CONTEXTS.has(context)) throw new QueryErrors.Error('invalid_context');
  if (codecs === undefined) return;
  const table: unknown = (codecs as { readonly spec?: { readonly table?: unknown } } | null)?.spec
    ?.table;
  const model = typeof table === 'string' ? context.catalog.model(table) : undefined;
  if (model === undefined || context.catalog.codecs(model) !== codecs) {
    throw new QueryErrors.Error('invalid_context');
  }
}

/** A catalog that knows only `models` of `catalog`. */
export function restrictCatalog(
  catalog: StatementCatalog,
  models: readonly ModelTarget[],
): StatementCatalog {
  const tables = new Set<string>();
  for (const model of models) {
    const definition = modelDefinition(model);
    if (definition !== undefined) tables.add(definition.spec.table);
  }
  const known = new Set(models);
  return Object.freeze({
    dialect: catalog.dialect,
    models: Object.freeze([...known]),
    has: (table: string) => tables.has(table),
    tenant: (table: string) => (tables.has(table) ? catalog.tenant(table) : undefined),
    model: (table: string) => (tables.has(table) ? catalog.model(table) : undefined),
    codecs: (target: ModelTarget): ModelCodecs => {
      if (!known.has(target)) {
        const name = modelDefinition(target)?.spec.table ?? 'unknown';
        throw new StatementErrors.Error('unknown_table', { table: name });
      }
      return catalog.codecs(target);
    },
  });
}

/** Runs one statement on a held lease, guarded under the ambient tenant scope. */
export type LeasedRun = (statement: Statement) => Promise<QueryResult>;

/**
 * Hold one lease of `context`'s data source for `fn`, under the ambient
 * tenant scope (off when `unscoped`), and give `fn` the runner of statements
 * on it: a query and the relation loads of its records share one connection
 * (inside a transaction, the transaction's). The lease is released when `fn`
 * settles, so `fn` must not wait on work of its caller.
 *
 * @throws `query.invalid_context`, `data_source.closed`, and what `fn` throws.
 */
export async function withLease<T>(
  context: QueryContext,
  unscoped: boolean,
  fn: (run: LeasedRun) => Promise<T>,
): Promise<T> {
  assertQuerySource(context);
  const internals = internalsOf(context.dataSource);
  internals.assertOpen();
  const engine = await internals.engine();
  const body = async (): Promise<T> => {
    const conn = await engine.lease();
    try {
      return await fn((statement) => executeStatement(conn, context.catalog, statement));
    } finally {
      await conn.release();
    }
  };
  return unscoped ? withoutTenantScope(body) : body();
}

/**
 * Run `statement` in `context` under the ambient tenant scope (off when
 * `unscoped`), on a lease of its own.
 *
 * @throws `query.invalid_context`, `data_source.closed`, the guarded
 *   compile's codes, and the engine's `DatabaseError`s.
 */
export function runStatement(
  context: QueryContext,
  statement: Statement,
  unscoped = false,
): Promise<QueryResult> {
  return withLease(context, unscoped, (run) => run(statement));
}
