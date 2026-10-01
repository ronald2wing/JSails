/**
 * JSails-owned chainable query surface wrapping a TypeORM SelectQueryBuilder.
 *
 * `ModelQuery<T>` provides a fluent, ESM-friendly API for building and
 * executing SELECT queries against Active Record entities. It delegates to
 * TypeORM for SQL generation and parameter binding — no hand-built SQL.
 *
 * Slice 1 covers the base chain and executors only: `where` (via `Q`
 * predicates), `orderBy`, `limit`, `offset`, `apply` (escape hatch), and the
 * terminal methods `getMany` / `getOne` / `count`.
 *
 * Slice 2 adds eager loading via `includes()` which delegates to the batch
 * relation loader (`loadRelations`) for post-fetch IN-clause batching.
 */

import { type SelectQueryBuilder } from 'typeorm';
import type { BaseEntity } from 'typeorm';

import { applyQ, assertValidColumn, type Q } from './query-expressions.js';
import { resolveScope, ScopeError } from './scopes.js';
import { loadRelations, type RelationLoadSpec } from './relation-loader/index.js';
import {
  applyWhereHas,
  applyHas,
  relationCount,
  type RelationPredicate,
} from './relation-query.js';
import { RelationError } from './relation-metadata.js';

// ---------------------------------------------------------------------------
// Spec merge helper (module-private)
// ---------------------------------------------------------------------------

/**
 * Merge two {@link RelationLoadSpec} objects into a single accumulated spec.
 * The caller's objects are never mutated; a new object is always returned.
 *
 * Merge rules:
 * - {@code false} in the incoming spec removes the key from the result —
 *   an explicit opt-out overrides any earlier value.
 * - {@code true} sets the key to {@code true} unless the existing value is
 *   already a {@link RelationLoadOptions} object (options > boolean).
 * - An options object overwrites a boolean and deep-merges {@code with}
 *   with an existing options object; non-{@code with} fields from the
 *   incoming spec take precedence (later call wins).
 */
function mergeSpecs(a: RelationLoadSpec, b: RelationLoadSpec): RelationLoadSpec {
  const result: RelationLoadSpec = { ...a };

  for (const [key, value] of Object.entries(b)) {
    if (value === false) {
      delete result[key];
      continue;
    }

    const existing = result[key];

    if (typeof value === 'boolean') {
      // value is true — set only if the existing entry is not already an
      // options object (options carry more detail and take priority).
      if (typeof existing !== 'object' || existing === null) {
        result[key] = true;
      }
      continue;
    }

    // value is a RelationLoadOptions object.
    if (!existing || typeof existing === 'boolean') {
      result[key] = { ...value };
    } else {
      const nestedWith =
        value.with !== undefined ? mergeSpecs(existing.with ?? {}, value.with) : existing.with;
      result[key] = { ...existing, ...value, with: nestedWith };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Raised for ModelQuery construction and validation failures. Value-free. */
export class ModelQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelQueryError';
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ModelQueryOptions {
  /** Alias for the base table. Defaults to 'entity_' (matching relation-query.ts). */
  alias?: string;
}

/** One ORDER BY term used to build a keyset cursor. */
interface OrderSpec {
  /** Column identifier as passed to {@link ModelQuery.orderBy}. */
  column: string;
  direction: 'ASC' | 'DESC';
}

// ---------------------------------------------------------------------------
// ModelQuery
// ---------------------------------------------------------------------------

/**
 * Chainable SELECT query builder for a single entity.
 *
 * Use the standalone {@link query} factory rather than constructing this
 * class directly.
 */
export class ModelQuery<T extends object> {
  /** The underlying TypeORM SelectQueryBuilder — an escape hatch for raw access. */
  readonly builder: SelectQueryBuilder<T>;

  /** Table alias used by this builder for column qualification. */
  private readonly alias: string;

  /** The entity class this query targets, needed for relation predicate resolution. */
  readonly #entity: typeof BaseEntity;

  /**
   * The entity class this query targets.
   *
   * Exposed so a consumer can reach the entity's TypeORM metadata (e.g. the
   * live layer's row projection) without rebuilding the query. This is the
   * metadata discriminator the projection needs (LIVE-PLAN.md Phase 1).
   */
  get entity(): typeof BaseEntity {
    return this.#entity;
  }

  /**
   * Accumulated eager-load spec built from one or more {@link includes} calls.
   * `undefined` when no includes have been declared. The object is frozen
   * after every merge so callers cannot mutate it through a held reference.
   */
  #includesSpec: RelationLoadSpec | undefined;

  /** Relation names to annotate with counts (post-fetch, via relationCount). */
  #annotations: string[] = [];

  /**
   * Ordering declared through {@link orderBy}, in call order. Batching needs
   * the full ordering to build a keyset cursor; the builder does not expose
   * its accumulated ORDER BY in a form we can read back.
   */
  #orderSpecs: OrderSpec[] = [];

  /** Whether {@link apply} was called (read by the live layer's shape guard). */
  #applied = false;

  constructor(builder: SelectQueryBuilder<T>, alias: string, entity: typeof BaseEntity) {
    this.builder = builder;
    this.alias = alias;
    this.#entity = entity;
  }

  /**
   * Add a WHERE condition from a portable `Q` predicate.
   * Delegates to {@link applyQ} with this builder's alias so later slices
   * (whereHas et al.) correlate correctly.
   */
  where(predicate: Q): this {
    applyQ(this.builder, predicate, this.alias);
    return this;
  }

  /**
   * Add an ORDER BY clause. The column identifier is validated against the
   * same regex as {@link applyQ} — letters, digits, and underscores only.
   *
   * Defaults to ascending order when `direction` is omitted.
   */
  orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
    try {
      assertValidColumn(column);
    } catch {
      throw new ModelQueryError('Invalid column identifier');
    }
    this.builder.addOrderBy(`${this.alias}.${column}`, direction);
    this.#orderSpecs.push({ column, direction });
    return this;
  }

  /** Set the maximum number of rows returned. Rejects non-integer or negative values. */
  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new ModelQueryError('Limit must be a non-negative integer');
    }
    this.builder.limit(n);
    return this;
  }

  /** Skip the first N rows. Rejects non-integer or negative values. */
  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new ModelQueryError('Offset must be a non-negative integer');
    }
    this.builder.offset(n);
    return this;
  }

  /**
   * Whether {@link apply} was called on this query.
   *
   * Exposed so the live layer's {@code assertPublicationShape} can detect the
   * raw escape hatch, which defeats the shape constraint's membership guarantee
   * (LIVE-PLAN.md §4.2a). A public getter because the guard lives in a different
   * module than this private flag.
   */
  get applied(): boolean {
    return this.#applied;
  }

  /** Apply a raw callback to the underlying builder — an escape hatch for
   *  operations not yet exposed on ModelQuery. */
  apply(fn: (qb: SelectQueryBuilder<T>) => void): this {
    this.#applied = true;
    fn(this.builder);
    return this;
  }

  /**
   * Apply a named scope registered for this entity via {@link scope}. Forwards
   * `args` to the scope body; the scope mutates the query in place and its
   * return value (if any) is ignored.
   *
   * @throws {ScopeError} (`unknown_scope`) when the entity has no such scope.
   */
  scope(name: string, ...args: unknown[]): this {
    const fn = resolveScope(this.#entity, name);
    if (fn === undefined) {
      throw new ScopeError('unknown_scope', 'scope is not defined for this model');
    }
    fn(this, ...args);
    return this;
  }

  /**
   * Filter to rows that have at least one related row matching the optional
   * predicate. Compiles to `WHERE EXISTS (SELECT 1 FROM <related> ...)`.
   *
   * Delegates to {@link applyWhereHas} from `relation-query.js`. Supports
   * nested dotted paths (`comments.author`); polymorphic relations are
   * rejected. Composes with {@link includes} so the filtered parents can also
   * eager-load those same relations.
   *
   * The builder's alias must be `'entity_'` (the default) for correlation to
   * match between the outer query and the EXISTS subquery. A custom alias
   * silently produces incorrect SQL — the underlying relation helpers hardcode
   * `'entity_'` and this method does not validate the alias for backwards
   * compatibility with the standalone `whereHas` function.
   */
  whereHas(relation: string, predicate?: RelationPredicate): this {
    applyWhereHas(this.builder, this.#entity, relation, predicate);
    return this;
  }

  /**
   * Filter to rows where the COUNT of related rows satisfies a numeric
   * comparison. Compiles to `WHERE (SELECT COUNT(1) FROM <related> ...) <op> <count>`.
   *
   * Delegates to {@link applyHas} from `relation-query.js`. Nested paths are
   * rejected. Same alias constraint as {@link whereHas}.
   */
  has(relation: string, operator: '>' | '>=' | '=' | '<' | '<=', count: number): this {
    applyHas(this.builder, this.#entity, relation, operator, count);
    return this;
  }

  /**
   * Declare relations to eager-load after the base query executes.
   *
   * Delegates to {@link loadRelations} which loads related entities with
   * IN-clause batching — one query per relation level, never per parent row.
   *
   * Repeated calls accumulate via deep merge:
   * `q.includes({ author: true }).includes({ comments: true })` results in
   * `{ author: true, comments: true }`. When a key holds an options object
   * with nested `with`, those nested specs are deep-merged rather than
   * overwritten. An explicit `false` removes a previously-included relation.
   *
   * @throws {ModelQueryError} when `spec` is not a plain object.
   */
  includes(spec: RelationLoadSpec): this {
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new ModelQueryError('includes() expects an object spec');
    }

    this.#includesSpec = this.#includesSpec ? mergeSpecs(this.#includesSpec, spec) : { ...spec };

    // Freeze so a caller cannot mutate the accumulated spec through a
    // previously-passed reference. The shallow freeze is sufficient because
    // callers provide fresh plain objects or our merge creates new ones.
    Object.freeze(this.#includesSpec);

    return this;
  }

  // -----------------------------------------------------------------------
  // Annotation helpers
  // -----------------------------------------------------------------------

  /**
   * Apply aggregated counts for every declared annotation to the given rows.
   *
   * Calls {@link relationCount} once per annotation (each issues one GROUP BY)
   * and attaches the count under `<relation>_count` on each row. Rows whose
   * PK is absent from the map receive `0`.
   *
   * @throws {ModelQueryError} when a relation is unknown (wraps {@link RelationError}).
   */
  async #applyAnnotations(rows: T[]): Promise<void> {
    const pkCols = this.#entity.getRepository().metadata.primaryColumns;

    for (const relation of this.#annotations) {
      let countMap: Map<string, number>;
      try {
        countMap = await relationCount(this.#entity, relation);
      } catch (err) {
        if (err instanceof RelationError) {
          throw new ModelQueryError('Invalid annotation: unknown relation');
        }
        throw err;
      }

      const prop = `${relation}_count`;
      for (const row of rows) {
        const pkValues = pkCols.map((c) => (row as Record<string, unknown>)[c.propertyName]);
        const key = pkValues.length === 1 ? String(pkValues[0]) : JSON.stringify(pkValues);
        (row as Record<string, unknown>)[prop] = countMap.get(key) ?? 0;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Executors
  // -----------------------------------------------------------------------

  /**
   * Execute and return all matching rows, then eager-load any relations
   * declared via {@link includes} and apply {@link annotate} counts.
   * When the base query returns zero rows the loader and annotations are
   * skipped entirely.
   */
  async getMany(): Promise<T[]> {
    const rows = await this.builder.getMany();
    if (rows.length === 0) {
      return rows;
    }

    let result = rows;

    if (this.#includesSpec) {
      result = await loadRelations(rows, { with: this.#includesSpec });
    }

    if (this.#annotations.length > 0) {
      await this.#applyAnnotations(result);
    }

    return result;
  }

  /**
   * Execute and return the first matching row, or `null` when empty, then
   * eager-load any relations declared via {@link includes} and apply
   * {@link annotate} counts. A `null` result skips both the loader and
   * annotations so no extra query is issued for a missing row.
   */
  async getOne(): Promise<T | null> {
    const row = await this.builder.getOne();
    if (!row) {
      return row;
    }

    let result = row;

    if (this.#includesSpec) {
      const [loaded] = await loadRelations([row], { with: this.#includesSpec });
      result = loaded ?? row;
    }

    if (this.#annotations.length > 0) {
      await this.#applyAnnotations([result]);
    }

    return result;
  }

  /**
   * Execute and return the row count. Annotations and includes have no
   * effect on counting — relations are neither filtered nor joined.
   */
  count(): Promise<number> {
    return this.builder.getCount();
  }

  // -----------------------------------------------------------------------
  // annotate — post-fetch relation counts
  // -----------------------------------------------------------------------

  /**
   * Record one or more relations whose row counts will be attached to each
   * result row by {@link getMany} / {@link getOne}.
   *
   * Counts are computed via {@link relationCount} — one GROUP BY query per
   * annotated relation, executed *after* the base query and any eager loads.
   * The count is stored under `<relation>_count` on each row and never
   * overwrites an existing entity property (the suffix prevents collisions).
   *
   * Unknown relations throw a value-free {@link ModelQueryError} lazily at
   * execution time.
   */
  annotate(relation: string, ...relations: string[]): this {
    this.#annotations.push(relation, ...relations);
    return this;
  }

  // -----------------------------------------------------------------------
  // in_batches — paginated iteration
  // -----------------------------------------------------------------------

  /**
   * Resolve the ordering used for a batch walk: the caller's {@link orderBy}
   * terms, or the primary key when none were declared, with the primary key
   * appended as a tiebreaker so the cursor is total.
   */
  #batchOrder(): OrderSpec[] {
    const pkColumns = this.#entity.getRepository().metadata.primaryColumns;
    const specs: OrderSpec[] =
      this.#orderSpecs.length > 0
        ? this.#orderSpecs.map((spec) => ({ ...spec }))
        : pkColumns.map((col) => ({ column: col.propertyName, direction: 'ASC' as const }));

    const seen = new Set(specs.map((spec) => spec.column));
    for (const col of pkColumns) {
      if (!seen.has(col.propertyName)) {
        specs.push({ column: col.propertyName, direction: 'ASC' });
        seen.add(col.propertyName);
      }
    }
    return specs;
  }

  /**
   * Replace the builder's ORDER BY with `order`, forcing NULLS FIRST on every
   * term. The cursor predicate assumes that null placement, and the default
   * differs between SQLite and Postgres; pinning it keeps the walk portable.
   */
  #applyBatchOrder(order: readonly OrderSpec[]): void {
    const [first, ...rest] = order;
    if (first === undefined) return;
    this.builder.orderBy(`${this.alias}.${first.column}`, first.direction, 'NULLS FIRST');
    for (const spec of rest) {
      this.builder.addOrderBy(`${this.alias}.${spec.column}`, spec.direction, 'NULLS FIRST');
    }
  }

  /**
   * Build the lexicographic "strictly after the cursor" predicate for `order`.
   *
   * Each term contributes an `after` branch and an `equality` branch. With
   * NULLS FIRST, a NULL cursor value means every non-null value follows in
   * both directions, so the same shape works for ASC and DESC. The
   * `mq_cursor_active` guard makes the predicate a no-op on the first page.
   */
  #cursorPredicate(order: readonly OrderSpec[]): string {
    const branches: string[] = [];
    const equalities: string[] = [];

    order.forEach((spec, index) => {
      const param = `mq_cursor_${index}`;
      const column = `${this.alias}.${spec.column}`;
      const operator = spec.direction === 'ASC' ? '>' : '<';
      const after = `(${column} ${operator} :${param} OR (:${param} IS NULL AND ${column} IS NOT NULL))`;
      branches.push([...equalities, after].join(' AND '));
      equalities.push(`(${column} = :${param} OR (:${param} IS NULL AND ${column} IS NULL))`);
    });

    return `(:mq_cursor_active = 0 OR (${branches.join(' OR ')}))`;
  }

  /**
   * Read the cursor value for `spec` from a row. `orderBy` takes a column
   * identifier, which may be a database name; rows expose property names.
   */
  #cursorValue(row: T, spec: OrderSpec): unknown {
    const metadata = this.#entity.getRepository().metadata;
    const property = metadata.findColumnWithDatabaseName(spec.column)?.propertyName ?? spec.column;
    return (row as Record<string, unknown>)[property] ?? null;
  }

  /**
   * Iterate query results in pages of `size`, calling `fn(rows, page)` for
   * each non-empty page. Stops when a page returns zero rows.
   *
   * Traversal is keyset-based: each page continues strictly after the last
   * row of the previous page, so deleting or inserting rows during the walk
   * cannot shift the window. Rows present for the whole walk are seen exactly
   * once; concurrent inserts/deletes may or may not be observed. There is no
   * snapshot isolation.
   *
   * When no {@link orderBy} was set, a deterministic ordering by the entity's
   * primary key (ASC) is used. The primary key is always appended as a
   * tiebreaker so the cursor is total.
   *
   * `options.offset` skips that many rows before the first batch only.
   *
   * Each page applies the caller's existing {@link where} / {@link includes} /
   * {@link annotate} configuration, so `fn` receives fully loaded and
   * annotated rows.
   *
   * @throws {ModelQueryError} when `size` is not a positive integer.
   */
  async in_batches(
    size: number,
    fn: (rows: T[], page: number) => Promise<void> | void,
    options?: { offset?: number },
  ): Promise<void> {
    if (!Number.isInteger(size) || size < 1) {
      throw new ModelQueryError('Batch size must be a positive integer');
    }

    const order = this.#batchOrder();
    this.#applyBatchOrder(order);

    const cursorParams: Record<string, unknown> = { mq_cursor_active: 0 };
    order.forEach((_, index) => {
      cursorParams[`mq_cursor_${index}`] = null;
    });
    this.builder.andWhere(this.#cursorPredicate(order), cursorParams);

    const initialOffset = options?.offset ?? 0;
    let page = 1;
    let firstPage = true;

    while (true) {
      this.builder.limit(size);
      this.builder.offset(firstPage ? initialOffset : 0);
      const rows = await this.getMany();
      if (rows.length === 0) break;
      await fn(rows, page);
      page += 1;
      firstPage = false;

      const last = rows[rows.length - 1];
      if (last === undefined) break;

      const nextParams: Record<string, unknown> = { mq_cursor_active: 1 };
      order.forEach((spec, index) => {
        nextParams[`mq_cursor_${index}`] = this.#cursorValue(last, spec);
      });
      this.builder.setParameters(nextParams);
    }
  }

  // -----------------------------------------------------------------------
  // find_each — row-level iteration
  // -----------------------------------------------------------------------

  /**
   * Iterate every matching row one at a time, calling `fn(row)` for each.
   *
   * Convenience over {@link in_batches}: internally pages by `batchSize`
   * (default 100) and invokes `fn` per row within each page.
   */
  async find_each(
    fn: (row: T) => Promise<void> | void,
    options?: { batchSize?: number },
  ): Promise<void> {
    const batchSize = options?.batchSize ?? 100;
    await this.in_batches(batchSize, async (rows) => {
      for (const row of rows) {
        await fn(row);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link ModelQuery} for an Active Record entity.
 *
 * The default alias is `'entity_'` to match {@link relation-query.ts}'s
 * hardcoded alias, so a later `whereHas` slice can correlate subqueries
 * against the base table.
 */
export function query<T extends object>(
  entity: typeof BaseEntity,
  options?: ModelQueryOptions,
): ModelQuery<T> {
  const alias = options?.alias ?? 'entity_';
  const repo = entity.getRepository();
  const builder = repo.createQueryBuilder(alias) as SelectQueryBuilder<T>;
  return new ModelQuery(builder, alias, entity);
}
