/**
 * `ModelQuery<T, R>`: an immutable query over one model. Every method that
 * narrows, orders or shapes it returns a new query; the query itself is a
 * frozen value (compiled predicate, sort terms, limit, offset, lock,
 * projection, tenant opt-out) bound to the data source and catalog it was
 * built for, so sharing one, or running it twice, can never leak state from
 * one use into another. Only the package makes those parts: a query
 * constructed from a context, codecs or state of a caller's own is refused,
 * so the tenant policy and a handle's grants cannot be swapped out. Conditions are compiled, and their values encoded by
 * the column codecs, when they are added: a column that does not exist
 * fails where it is written, and an input object changed afterwards does not
 * change the query.
 *
 * `T` is the model's row type, which conditions and orders are checked
 * against; `R` is what the query returns: records of the model, or frozen
 * plain rows for `select` (and for a read grant of a model-set handle). A
 * projection is never a partial record, so it has no `save`.
 *
 * Reads: `getMany`, `getOne`, `count`, `exists`, `pluck`, and the keyset
 * walks `inBatches` and `findEach`, which build a fresh statement per batch
 * (`keyset.ts`). `includes` names relations to load with the records: after
 * the query's statement, one statement per relation level (per bind chunk),
 * all on the query's lease (`relation/`), typed as `Loaded<R, S>`. Set writes: `updateAll` and `deleteAll`, one statement each
 * plus the set form of the model's effects, returning the rows they matched
 * (`record/set-writes.ts`). There is no `apply`, no query builder, no
 * repository and no manager: the statement IR stays inside.
 */

import type { CodecColumn, ModelCodecs } from '../codec/model-codecs.js';
import { decodeRow, hydrate } from '../codec/hydrate.js';
import { encodeColumn } from '../codec/model-codecs.js';
import type { Row, SqlValue } from '../engine/contract.js';
import type { OrderTerm, Predicate, SelectColumn, SelectStatement } from '../engine/statement.js';
import { modelDefinition } from '../model/define-model.js';
import type { ModelTarget } from '../model/model-spec.js';
import {
  and,
  col,
  not,
  select as selectStatement,
  table as tableRef,
  TRUE,
} from '../statement/builders.js';
import type { Values } from '../statement/model-values.js';
import {
  compileOrder,
  compileWhere,
  type ColumnKey,
  type OrderBy,
  type WhereInput,
} from '../statement/where.js';
import { boundDataSource } from '../record/data-source.js';
import { DataSourceErrors } from '../record/record-errors.js';
import { keysetAfter, keysetOrder, keysetTerms, type SortTerm } from './keyset.js';
import { deleteRows, insertRows, updateRows, type SetWriteOptions } from '../record/set-writes.js';
import {
  assertQuerySource,
  dataSourceContext,
  withLease,
  type LeasedRun,
  type QueryContext,
  type WriteResult,
} from './query-context.js';
import { QueryErrors } from './query-errors.js';
import { relationExists, resolveRelation, type ResolvedRelation } from './relation-filter.js';
import { compileIncludes, loadIncludes, type IncludeNode } from '../relation/includes.js';
import type { LoadScope } from '../relation/load-relation.js';
import { RelationErrors } from '../relation/relation-errors.js';
import type { IncludeSpec, Loaded } from '../relation/relation-types.js';

/** A row lock: `FOR UPDATE` or `FOR SHARE`, and what to do about rows locked by others. */
export interface QueryLock {
  readonly mode: 'update' | 'share';
  readonly wait?: 'wait' | 'nowait' | 'skip-locked';
}

/** A count bound for {@link ModelQuery.has}. */
export type CountComparison = '>' | '>=' | '=' | '<' | '<=';

/**
 * A reusable query fragment: a function of a query (and its own arguments)
 * returning a narrower query of the same model. `scope(fn, ...args)` applies
 * one; there is no registry of named scopes. `U` is the row type of the
 * query it returns, a `Loaded` record when it includes relations.
 */
export type ScopeFunction<T extends object, A extends readonly unknown[] = [], U extends T = T> = (
  query: ModelQuery<T>,
  ...args: A
) => ModelQuery<T, U>;

/** The row type of a query of rows `R` after a scope returning rows `U`. */
export type ScopedRow<T extends object, R, U extends T> = [T] extends [U] ? R : R & U;

/**
 * Conditions on a relation's target: a `Where` of the target, or a function
 * of a query of the target that narrows it (and may filter on the target's
 * own relations).
 */
export type RelationFilter<S extends object> =
  WhereInput<S> | ((query: ModelQuery<S>) => ModelQuery<S>);

/** The frozen value of a query. */
export interface QueryState {
  readonly where: Predicate;
  readonly order: readonly SortTerm[];
  readonly limit: number | undefined;
  readonly offset: number | undefined;
  readonly lock: QueryLock | undefined;
  readonly unscoped: boolean;
  /** Selected properties; `undefined` reads whole rows. */
  readonly projection: readonly string[] | undefined;
  /** The relations loaded with the records, compiled. */
  readonly includes: readonly IncludeNode[];
}

const EMPTY_STATE: QueryState = Object.freeze({
  where: TRUE,
  order: Object.freeze([]),
  limit: undefined,
  offset: undefined,
  lock: undefined,
  unscoped: false,
  projection: undefined,
  includes: Object.freeze([]),
});

/** Every state a query method made; a constructed query takes no other. */
const STATES = new WeakSet<QueryState>([EMPTY_STATE]);

const LOCK_MODES: ReadonlySet<string> = new Set(['update', 'share']);
const LOCK_WAITS: ReadonlySet<string> = new Set(['wait', 'nowait', 'skip-locked']);
const COMPARISONS: ReadonlySet<string> = new Set(['>', '>=', '=', '<', '<=']);

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An immutable query over one model. */
export class ModelQuery<T extends object, R = T> {
  readonly #context: QueryContext;
  readonly #codecs: ModelCodecs;
  readonly #state: QueryState;

  /**
   * A query of `codecs`' model in `context`. Queries start from a model
   * (`Post.where`, `query(PostTag)`) or a data handle: the context, the
   * codecs and the state must be ones the package made, since the context's
   * catalog carries the tenant policy and its grants.
   *
   * @throws `query.invalid_context` for anything else.
   */
  constructor(context: QueryContext, codecs: ModelCodecs, state: QueryState = EMPTY_STATE) {
    assertQuerySource(context, codecs);
    if (!STATES.has(state)) throw new QueryErrors.Error('invalid_context');
    this.#context = context;
    this.#codecs = codecs;
    this.#state = state;
    Object.freeze(this);
  }

  #next<N = R>(change: Partial<QueryState>): ModelQuery<T, N> {
    const state: QueryState = Object.freeze({ ...this.#state, ...change });
    STATES.add(state);
    return new ModelQuery<T, N>(this.#context, this.#codecs, state);
  }

  get #table(): string {
    return this.#codecs.spec.table;
  }

  #invalid(method: string, argument: string): never {
    throw new QueryErrors.Error('invalid_argument', {
      model: this.#codecs.spec.name,
      method,
      argument,
    });
  }

  /** Rows matching `where` as well as every condition so far. */
  where(where: WhereInput<T>): ModelQuery<T, R> {
    return this.#next({
      where: and(this.#state.where, compileWhere(this.#codecs, where, this.#table)),
    });
  }

  /**
   * Order by `order` after any order set so far. A walk (`inBatches`,
   * `findEach`) adds the primary key as the last term.
   */
  orderBy(order: OrderBy<T> | readonly OrderBy<T>[]): ModelQuery<T, R> {
    compileOrder(this.#codecs, order);
    const terms: readonly unknown[] = Array.isArray(order) ? order : [order];
    const added = terms.map((term): SortTerm => {
      const spec = (typeof term === 'string' ? { column: term } : term) as {
        readonly column: string;
        readonly direction?: 'asc' | 'desc';
        readonly nulls?: 'first' | 'last';
      };
      const column = this.#codecs.property(spec.column) as CodecColumn;
      return Object.freeze({
        column,
        direction: spec.direction ?? 'asc',
        ...(spec.nulls === undefined ? {} : { nulls: spec.nulls }),
      });
    });
    return this.#next({ order: Object.freeze([...this.#state.order, ...added]) });
  }

  /** At most `count` rows. */
  limit(count: number): ModelQuery<T, R> {
    if (!isCount(count)) this.#invalid('limit', 'count');
    return this.#next({ limit: count });
  }

  /** Skip the first `count` rows. */
  offset(count: number): ModelQuery<T, R> {
    if (!isCount(count)) this.#invalid('offset', 'count');
    return this.#next({ offset: count });
  }

  /**
   * Lock the rows read for the rest of the transaction (`FOR UPDATE`, or
   * `FOR SHARE`). Outside a transaction a lock lasts one statement. SQLite
   * renders none: its write transactions hold the database's write lock.
   *
   * A lock of either mode blocks the owner's writes to the rows, so it takes
   * write access: a read grant of a model-set handle refuses it
   * (`data_source.not_granted`).
   */
  lock(mode: QueryLock['mode'] = 'update', wait?: QueryLock['wait']): ModelQuery<T, R> {
    if (!LOCK_MODES.has(mode)) this.#invalid('lock', 'mode');
    if (wait !== undefined && !LOCK_WAITS.has(wait)) this.#invalid('lock', 'wait');
    this.#assertWritable();
    return this.#next({ lock: Object.freeze(wait === undefined ? { mode } : { mode, wait }) });
  }

  /** Run every statement of this query with the tenant scope off (recorded in the query ledger). */
  withoutTenantScope(): ModelQuery<T, R> {
    return this.#next({ unscoped: true });
  }

  /**
   * Apply a scope: `query.scope(published)`, `query.scope(popular, 10)`. The
   * scope's query is the result, with this query's projection, and with this
   * query's includes followed by those the scope added (a scope that
   * includes relations types its records as loaded).
   *
   * @throws `query.invalid_argument` when `fn` is no function or returns no
   *   query of this model and data source, `relation.invalid_include` when
   *   the scope includes a relation this query already includes, and
   *   `relation.plain_rows` when it includes relations on a query of plain
   *   rows.
   */
  scope<A extends readonly unknown[], U extends T = T>(
    fn: ScopeFunction<T, A, U>,
    ...args: A
  ): ModelQuery<T, ScopedRow<T, R, U>> {
    if (typeof fn !== 'function') this.#invalid('scope', 'fn');
    const scoped: unknown = fn(this.#next<T>({}), ...args);
    if (!(scoped instanceof ModelQuery) || !this.#sameSource(scoped)) {
      this.#invalid('scope', 'fn');
    }
    const { projection, includes } = this.#state;
    const added = (scoped as ModelQuery<T, U>).#state.includes.filter(
      (node) => !includes.includes(node),
    );
    if (added.some((node) => includes.some((held) => held.name === node.name))) {
      throw new RelationErrors.Error('invalid_include', { model: this.#codecs.spec.name });
    }
    if (added.length > 0 && projection !== undefined) this.#plainRows();
    return (scoped as ModelQuery<T, U>).#next<ScopedRow<T, R, U>>({
      projection,
      includes: added.length === 0 ? includes : Object.freeze([...includes, ...added]),
    });
  }

  #sameSource(other: ModelQuery<object, unknown>): boolean {
    return other.#codecs === this.#codecs && other.#context === this.#context;
  }

  /** The conditions a relation filter puts on `relation`'s target, qualified by its table. */
  #filterOf<S extends object>(
    relation: ResolvedRelation,
    filter: RelationFilter<S> | undefined,
  ): Predicate {
    if (filter === undefined) return TRUE;
    const target = relation.target;
    if (typeof filter !== 'function') return compileWhere(target, filter, target.spec.table);
    const inner = new ModelQuery<S>(this.#context, target);
    const narrowed: unknown = filter(inner);
    const invalid = (): never => {
      throw new QueryErrors.Error('invalid_relation_filter', {
        model: this.#codecs.spec.name,
        relation: relation.name,
      });
    };
    if (!(narrowed instanceof ModelQuery) || !inner.#sameSource(narrowed)) return invalid();
    const state = (narrowed as ModelQuery<S>).#state;
    if (
      state.order.length > 0 ||
      state.limit !== undefined ||
      state.offset !== undefined ||
      state.lock !== undefined ||
      state.projection !== undefined ||
      state.includes.length > 0 ||
      state.unscoped
    ) {
      return invalid();
    }
    return state.where;
  }

  /**
   * Rows with at least one row of `relation` (matching `filter`): a
   * correlated `EXISTS`. Type the target with the type argument:
   * `whereHas<Comment>('comments', { approved: true })`.
   */
  whereHas<S extends object = Record<string, unknown>>(
    relation: string,
    filter?: RelationFilter<S>,
  ): ModelQuery<T, R> {
    if (typeof relation !== 'string') this.#invalid('whereHas', 'relation');
    const resolved = resolveRelation(this.#context.catalog, this.#codecs, relation);
    const condition = relationExists(resolved, {
      outer: this.#table,
      filter: this.#filterOf(resolved, filter),
    });
    return this.#next({ where: and(this.#state.where, condition) });
  }

  /**
   * Rows whose number of `relation` rows (matching `filter`) compares to
   * `count` as `comparison` says: `has('comments', '>=', 3)`.
   */
  has<S extends object = Record<string, unknown>>(
    relation: string,
    comparison: CountComparison,
    count: number,
    filter?: RelationFilter<S>,
  ): ModelQuery<T, R> {
    if (typeof relation !== 'string') this.#invalid('has', 'relation');
    if (!COMPARISONS.has(comparison)) this.#invalid('has', 'comparison');
    if (!isCount(count) || count === Number.MAX_SAFE_INTEGER) this.#invalid('has', 'count');
    const resolved = resolveRelation(this.#context.catalog, this.#codecs, relation);
    const narrowed = this.#filterOf(resolved, filter);
    const atLeast = (n: number): Predicate =>
      n <= 0
        ? TRUE
        : relationExists(resolved, { outer: this.#table, filter: narrowed, skip: n - 1 });
    let condition: Predicate;
    switch (comparison) {
      case '>=':
        condition = atLeast(count);
        break;
      case '>':
        condition = atLeast(count + 1);
        break;
      case '<':
        condition = not(atLeast(count));
        break;
      case '<=':
        condition = not(atLeast(count + 1));
        break;
      case '=':
        condition = and(atLeast(count), not(atLeast(count + 1)));
        break;
    }
    return this.#next({ where: and(this.#state.where, condition) });
  }

  #plainRows(): never {
    throw new RelationErrors.Error('plain_rows', { model: this.#codecs.spec.name });
  }

  /**
   * Load the relations `spec` names with the records: a relation name, a
   * list of names, or an object naming relations with `true` or their load
   * options (`where`, `order`, a per-parent `limit`, `maxRows`, and a nested
   * `include`). `getMany`, `getOne`, `inBatches` and `findEach` load them,
   * after the query's statement and on its lease, one statement per relation
   * level (per bind chunk), and every record then holds each relation (empty
   * or `null` when nothing matched); `count`, `exists`, `pluck` and the set
   * writes ignore them. The loads of a query `withoutTenantScope` are
   * unscoped too.
   *
   * @throws `relation.plain_rows` on a query returning plain rows,
   *   `relation.invalid_include` for a malformed spec or a relation included
   *   twice, `relation.invalid_option`, `query.unknown_relation`,
   *   `query.unsupported_relation`, and the `statement.*` codes of a
   *   malformed condition or order.
   */
  includes<const S extends IncludeSpec<T>>(spec: S): ModelQuery<T, Loaded<R, S>> {
    if (!this.#context.records || this.#state.projection !== undefined) this.#plainRows();
    const includes = compileIncludes(
      this.#context.catalog,
      this.#codecs,
      spec,
      this.#state.includes,
    );
    return this.#next<Loaded<R, S>>({ includes });
  }

  /** Return frozen plain rows of only `columns`, never records. */
  select<K extends ColumnKey<T>>(...columns: K[]): ModelQuery<T, Readonly<Pick<T, K>>> {
    if (this.#state.includes.length > 0) this.#plainRows();
    if (columns.length === 0) this.#invalid('select', 'columns');
    for (const column of columns) {
      if (typeof column !== 'string' || this.#codecs.property(column) === undefined) {
        this.#invalid('select', 'columns');
      }
    }
    return this.#next<Readonly<Pick<T, K>>>({ projection: Object.freeze([...new Set(columns)]) });
  }

  #orderTerms(terms: readonly SortTerm[]): readonly OrderTerm[] {
    return terms.map((term) =>
      Object.freeze({
        column: col(this.#table, term.column.column),
        direction: term.direction,
        ...(term.nulls === undefined ? {} : { nulls: term.nulls }),
      }),
    );
  }

  #columns(properties: readonly string[] | undefined): readonly SelectColumn[] {
    const columns =
      properties === undefined
        ? this.#codecs.columns
        : properties.map((property) => this.#codecs.property(property) as CodecColumn);
    return columns.map((column) =>
      Object.freeze({ column: col(this.#table, column.column), as: column.column }),
    );
  }

  #statement(parts: Partial<Omit<SelectStatement, 'kind' | 'from'>>): SelectStatement {
    const { where, lock } = this.#state;
    return selectStatement(tableRef(this.#table), {
      ...(where.op === 'true' ? {} : { where }),
      ...(lock === undefined ? {} : { lock }),
      ...parts,
    });
  }

  #run(statement: SelectStatement): Promise<readonly Row[]> {
    return withLease(
      this.#context,
      this.#state.unscoped,
      async (run) => (await run(statement)).rows,
    );
  }

  /**
   * Run `statement` and decode its rows, then load the query's includes onto
   * them, all on one lease.
   */
  #read(statement: SelectStatement, decode: (row: Row) => R): Promise<R[]> {
    return withLease(this.#context, this.#state.unscoped, async (run) => {
      const { rows } = await run(statement);
      const decoded = rows.map(decode);
      await this.#load(run, decoded as object[]);
      return decoded;
    });
  }

  /** Load the query's includes onto `records` through `run`. */
  async #load(run: LeasedRun, records: readonly object[]): Promise<void> {
    if (this.#state.includes.length === 0) return;
    const scope: LoadScope = {
      context: this.#context,
      run: async (statement) => (await run(statement)).rows,
    };
    await loadIncludes(scope, this.#state.includes, records);
  }

  #decode(row: Row, properties: readonly string[] | undefined): R {
    if (properties !== undefined) return decodeRow(this.#codecs, row, properties) as R;
    return (this.#context.records ? hydrate(this.#codecs, row) : decodeRow(this.#codecs, row)) as R;
  }

  /** Every matching row. */
  async getMany(): Promise<R[]> {
    const { order, limit, offset, projection } = this.#state;
    return this.#read(
      this.#statement({
        columns: this.#columns(projection),
        ...(order.length === 0 ? {} : { orderBy: this.#orderTerms(order) }),
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      }),
      (row) => this.#decode(row, projection),
    );
  }

  /** The first matching row, or `null`. */
  async getOne(): Promise<R | null> {
    if (this.#state.limit === 0) return null;
    const [first] = await this.#next({ limit: 1 }).getMany();
    return first ?? null;
  }

  /** The query's first column, as a narrow select list for counting and probing rows. */
  #firstColumn(): readonly SelectColumn[] {
    const first = this.#codecs.columns[0] as CodecColumn;
    return [{ column: col(this.#table, first.column), as: first.column }];
  }

  /**
   * How many rows `getMany()` would return. On a locked query it locks the
   * rows `getMany()` would lock: no dialect locks the rows behind an
   * aggregate, so it reads them, one column each, under the lock and counts
   * them.
   */
  async count(): Promise<number> {
    const { limit, offset, lock } = this.#state;
    if (limit === 0) return 0;
    if (lock !== undefined) {
      const locked = await this.#run(
        this.#statement({
          columns: this.#firstColumn(),
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        }),
      );
      return locked.length;
    }
    const rows = await this.#run(
      this.#statement({ columns: [{ aggregate: 'count', as: 'count' }] }),
    );
    const total = Number(rows[0]?.['count'] ?? 0);
    const remaining = Math.max(0, total - (offset ?? 0));
    return limit === undefined ? remaining : Math.min(limit, remaining);
  }

  /** Whether `getMany()` would return any row. */
  async exists(): Promise<boolean> {
    const { limit, offset } = this.#state;
    if (limit === 0) return false;
    const rows = await this.#run(
      this.#statement({
        columns: this.#firstColumn(),
        limit: 1,
        ...(offset === undefined ? {} : { offset }),
      }),
    );
    return rows.length > 0;
  }

  /** The values of one column, in the query's order. */
  pluck<K extends ColumnKey<T>>(column: K): Promise<T[K][]>;
  /** Tuples of several columns, in the query's order. */
  pluck<const K extends readonly [ColumnKey<T>, ColumnKey<T>, ...ColumnKey<T>[]]>(
    ...columns: K
  ): Promise<{ -readonly [I in keyof K]: T[K[I] & keyof T] }[]>;
  async pluck(...columns: string[]): Promise<unknown[]> {
    if (columns.length === 0) this.#invalid('pluck', 'columns');
    for (const column of columns) {
      if (typeof column !== 'string' || this.#codecs.property(column) === undefined) {
        this.#invalid('pluck', 'columns');
      }
    }
    const { order, limit, offset } = this.#state;
    const rows = await this.#run(
      this.#statement({
        columns: this.#columns(columns),
        ...(order.length === 0 ? {} : { orderBy: this.#orderTerms(order) }),
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      }),
    );
    return rows.map((row) => {
      const decoded = decodeRow(this.#codecs, row, columns);
      if (columns.length === 1) return decoded[columns[0] as string];
      return Object.freeze(columns.map((column) => decoded[column]));
    });
  }

  /**
   * Walk every matching row in batches of `size`, in the query's order with
   * the primary key as tiebreak, calling `fn` with each batch. Each batch is
   * a fresh statement continuing strictly after the last row of the previous
   * one (a keyset, never an offset), so the walk holds no state in the query,
   * rows present for the whole walk are seen exactly once, and every batch
   * reads through the order's index. `limit` caps the rows visited; `offset`
   * is refused. Rows inserted or deleted during the walk may or may not be
   * seen; there is no snapshot.
   */
  async inBatches(
    size: number,
    fn: (rows: R[], batch: number) => void | Promise<void>,
  ): Promise<void> {
    if (!isCount(size) || size === 0) this.#invalid('inBatches', 'size');
    if (typeof fn !== 'function') this.#invalid('inBatches', 'fn');
    const { order, limit, offset, projection } = this.#state;
    if (offset !== undefined) {
      throw new QueryErrors.Error('invalid_batch', {
        model: this.#codecs.spec.name,
        part: 'offset',
      });
    }
    const terms = keysetTerms(this.#codecs, order);
    const orderBy = keysetOrder(terms, this.#table);
    const fetched =
      projection === undefined
        ? undefined
        : [...new Set([...projection, ...terms.map((term) => term.column.property)])];
    const dialect = this.#context.catalog.dialect;
    let remaining = limit ?? Number.POSITIVE_INFINITY;
    let cursor: readonly SqlValue[] | undefined;
    for (let batch = 0; remaining > 0; batch += 1) {
      const take = Math.min(size, remaining);
      const after =
        cursor === undefined ? undefined : keysetAfter(terms, cursor, this.#table, dialect);
      const where = after === undefined ? this.#state.where : and(this.#state.where, after);
      // One lease per batch, released before `fn` runs: the batch's
      // statement and the loads of its includes share it.
      const decoded = await withLease(this.#context, this.#state.unscoped, async (run) => {
        const { rows } = await run(
          selectStatement(tableRef(this.#table), {
            columns: this.#columns(fetched),
            ...(where.op === 'true' ? {} : { where }),
            orderBy,
            limit: take,
            ...(this.#state.lock === undefined ? {} : { lock: this.#state.lock }),
          }),
        );
        const records = rows.map((row) =>
          fetched === undefined
            ? (this.#decode(row, undefined) as Record<string, unknown>)
            : decodeRow(this.#codecs, row, fetched),
        );
        if (fetched === undefined) await this.#load(run, records);
        return records;
      });
      if (decoded.length === 0) return;
      const last = decoded[decoded.length - 1] as Readonly<Record<string, unknown>>;
      // Taken before `fn` runs, so a batch changed in place cannot move the walk.
      cursor = terms.map((term) => encodeColumn(term.column, last[term.column.property]));
      const items =
        projection === undefined
          ? (decoded as R[])
          : decoded.map((row) => {
              const picked: Record<string, unknown> = {};
              for (const property of projection) picked[property] = row[property];
              return Object.freeze(picked) as R;
            });
      await fn(items, batch);
      remaining -= decoded.length;
      if (decoded.length < take) return;
    }
  }

  /** Call `fn` with every matching row, one at a time, read in batches of `batchSize` (100). */
  async findEach(
    fn: (row: R) => void | Promise<void>,
    options: { readonly batchSize?: number } = {},
  ): Promise<void> {
    if (typeof fn !== 'function') this.#invalid('findEach', 'fn');
    if (!isPlainObject(options)) this.#invalid('findEach', 'options');
    await this.inBatches(options.batchSize ?? 100, async (rows) => {
      for (const row of rows) await fn(row);
    });
  }

  #assertSetWrite(): void {
    const { limit, offset, lock, projection } = this.#state;
    const part =
      limit !== undefined
        ? 'limit'
        : offset !== undefined
          ? 'offset'
          : lock !== undefined
            ? 'lock'
            : projection !== undefined
              ? 'select'
              : undefined;
    if (part !== undefined) {
      throw new QueryErrors.Error('invalid_set_write', { model: this.#codecs.spec.name, part });
    }
    this.#assertWritable();
  }

  #assertWritable(): void {
    if (!this.#context.writable) {
      throw new DataSourceErrors.Error('not_granted', {
        model: this.#codecs.spec.name,
        access: 'write',
      });
    }
  }

  /**
   * Set `set` on every matching row in one statement, returning the rows it
   * matched (whether or not a value changed) on every driver. The values go
   * through the column codecs and the tenant policy, and the model's effects
   * run in set form (`set-writes.ts`): no record hooks or validation run, so
   * a model that declares them needs `{ skipHooks: true }`. With
   * `where({ id, lockVersion: n })` and `lockVersion: n + 1` in `set` it is
   * the conditional update: `affected` is 0 when the row moved on.
   *
   * @throws `query.set_write_skips_hooks`, `query.unsupported_set_write`.
   */
  async updateAll(set: Values<T>, options?: SetWriteOptions): Promise<WriteResult> {
    this.#assertSetWrite();
    return updateRows(
      this.#context,
      this.#codecs,
      this.#state.where,
      set,
      options,
      this.#state.unscoped,
    );
  }

  /**
   * Delete every matching row in one statement, returning how many it
   * deleted, with the set form of the model's effects (`set-writes.ts`).
   *
   * @throws `query.set_write_skips_hooks`, `query.unsupported_set_write`.
   */
  async deleteAll(options?: SetWriteOptions): Promise<WriteResult> {
    this.#assertSetWrite();
    return deleteRows(
      this.#context,
      this.#codecs,
      this.#state.where,
      options,
      this.#state.unscoped,
    );
  }
}

/** Type a scope: `const published = defineScope<Post>((q) => q.where({ status: 'live' }))`. */
export function defineScope<T extends object, A extends readonly unknown[] = [], U extends T = T>(
  fn: ScopeFunction<T, A, U>,
): ScopeFunction<T, A, U> {
  if (typeof fn !== 'function') {
    throw new QueryErrors.Error('invalid_argument', {
      model: 'scope',
      method: 'defineScope',
      argument: 'fn',
    });
  }
  return fn;
}

/** A class `defineModel` attached a spec to, as `query` takes it. */
type ModelConstructor = abstract new (...args: never[]) => object;

/**
 * A query of every row of `model`, on the data source it is bound to.
 * Records of a class model are instances of the class; rows of a
 * `defineTable` are plain objects.
 *
 * @throws `data_source.not_a_model`, `data_source.not_bound`.
 */
export function query<M extends ModelConstructor>(model: M): ModelQuery<InstanceType<M>>;
export function query<T extends object = Record<string, unknown>>(
  model: ModelTarget,
): ModelQuery<T>;
export function query(model: ModelTarget): ModelQuery<object> {
  const dataSource = boundDataSource(model);
  const context = dataSourceContext(dataSource);
  return new ModelQuery(context, context.catalog.codecs(model));
}

/**
 * Insert `rows` of `model` (a class model or a table) in as few statements
 * as the bind limit allows, all in one transaction, with the set form of the
 * model's effects (`set-writes.ts`).
 *
 * @throws `data_source.not_bound`, `statement.invalid_values`,
 *   `query.set_write_skips_hooks`, and the insert's codec, policy and
 *   database failures.
 */
export function insertAll<T extends object = Record<string, unknown>>(
  model: ModelTarget,
  rows: readonly Values<T>[],
  options?: SetWriteOptions,
): Promise<WriteResult> {
  if (modelDefinition(model) === undefined) throw new DataSourceErrors.Error('not_a_model');
  const context = dataSourceContext(boundDataSource(model));
  return insertRows(context, context.catalog.codecs(model), rows, options);
}
