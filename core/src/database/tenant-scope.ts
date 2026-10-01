/**
 * The tenant query guard: `tenantScoped(column)` marks a model as owned by a
 * tenant, and every query TypeORM builds for it is then held to the ambient
 * tenant (tenant-context.ts).
 *
 * ```ts
 * @tenantScoped('tenantId')
 * export class Project extends ApplicationRecord { ... }
 *
 * await runWithTenant(tenant.id, () => Project.find()); // only this tenant's rows
 * ```
 *
 * For a tenant-scoped model:
 * - every SELECT (Active Record `find*`/`count`/`exists`, `ModelQuery`, raw
 *   query builders, relation loads, subqueries) that reads it as its main
 *   table, an `addFrom` table, or a JOIN is filtered by the tenant column;
 *   with no current tenant the filter is `1 = 0`, so a read fails closed and
 *   returns nothing;
 * - an UPDATE or DELETE (including soft delete and restore) is filtered the
 *   same way, refuses to run without a tenant, and refuses a SET that would
 *   give the tenant column (or the relation that owns it) another value;
 * - an INSERT is stamped with the current tenant, refuses another tenant's
 *   id, and refuses to run without a tenant; INSERT … SELECT and upserts
 *   (`orUpdate`) are refused because their conflict branch can rewrite a row
 *   that belongs to another tenant.
 *
 * - a SELECT that TypeORM's query result cache would serve is refused: a
 *   result cached under an explicit id is handed to the next caller of that
 *   id whatever its tenant. `JsailsDataSource` refuses the cache outright;
 *   this covers a plain TypeORM `DataSource` that enables it.
 *
 * `withoutTenantScope(fn)` and `ModelQuery.withoutTenantScope()` are the
 * explicit opt-outs. Raw SQL (`query()`, `clear()`) never passes through a
 * query builder and is not scoped.
 *
 * Why patch TypeORM's query builders instead of wrapping repositories: every
 * read and write path — the Active Record statics, `EntityManager`, the
 * persistence layer behind `save()`, relation loaders, and hand-built
 * builders — renders its SQL through the same three protected methods
 * (`createWhereExpression`, `createJoinTreeRecursively`, `getValueSets`).
 * Hooking them once covers paths a repository wrapper would miss, and the
 * condition is added when the SQL is generated, so a later `.where()` cannot
 * replace it. The WHERE filter rides on TypeORM's own
 * `extraAppendedAndWhereCondition`, which the base method ANDs with the
 * caller's conditions inside parentheses.
 *
 * Subqueries are rendered to SQL when the outer query is built (`whereHas`,
 * a callback `from()`/`join()`), not when it runs, so a subquery's condition
 * holds no tenant: it reads three parameters (scope off, tenant present,
 * tenant id) that every outer (non-subquery) builder binds from the ambient
 * state each time it generates its SQL. A query built in one tenant context
 * and run in another is therefore held to the tenant current when it runs.
 */

import {
  BeforeInsert,
  InsertQueryBuilder,
  QueryBuilder,
  SelectQueryBuilder,
  type EntityMetadata,
  type ObjectLiteral,
} from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata.js';

import {
  tenantScopeShared,
  tenantScopeState,
  TenantScopeError,
  type TenantId,
  type TenantScopeState,
} from './tenant-context.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The registry, the column cache, and the registration count, shared with
 * every other loaded copy of jsails (tenant-context.ts). A count of zero lets
 * every query skip the lookup until a model is actually registered.
 */
const shared = tenantScopeShared();

const COLUMN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The prototype method TypeORM calls before inserting a tenant-scoped entity. */
const STAMP_METHOD = 'jsailsStampTenant';

/** The query parameter carrying the current tenant id. */
const TENANT_PARAMETER = 'jsails_tenant_scope_id';

/** The query parameter that is 1 inside `withoutTenantScope`. */
const OFF_PARAMETER = 'jsails_tenant_scope_off';

/** The query parameter that is 1 when there is a current tenant. */
const ON_PARAMETER = 'jsails_tenant_scope_on';

/**
 * The tenant column declared for `model` or an ancestor, or `undefined` when
 * the model is not tenant-scoped.
 */
export function tenantScopeColumn(model: Function): string | undefined {
  for (
    let current: unknown = model;
    typeof current === 'function' && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    const column = shared.registry.get(current);
    if (column !== undefined) return column;
  }
  return undefined;
}

function sameTenant(value: unknown, tenantId: TenantId): boolean {
  return (
    (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') &&
    String(value) === String(tenantId)
  );
}

function mismatch(): TenantScopeError {
  return new TenantScopeError(
    'tenant_mismatch',
    'a write may not set the tenant column to another tenant',
  );
}

function noTenant(): TenantScopeError {
  return new TenantScopeError(
    'no_tenant',
    'a tenant-scoped write needs a current tenant (runWithTenant)',
  );
}

/**
 * Declare `model` tenant-scoped, with `column` naming the scalar property that
 * holds the owning tenant's id. Returns a registrar usable as a class
 * decorator (`@tenantScoped('tenantId')`) or called directly
 * (`tenantScoped('tenantId')(Project)`). Declare it before the data source
 * initializes, as with any other entity decorator, so `save()` also stamps
 * the instance it inserts.
 *
 * @throws {TenantScopeError} (`invalid_column` / `duplicate_registration`).
 */
export function tenantScoped(column: string): (model: Function) => void {
  if (typeof column !== 'string' || !COLUMN_PATTERN.test(column)) {
    throw new TenantScopeError('invalid_column', 'tenant column must be a property name');
  }
  return (model: Function): void => {
    if (typeof model !== 'function') {
      throw new TenantScopeError('invalid_column', 'tenantScoped expects a model class');
    }
    if (tenantScopeColumn(model) !== undefined) {
      throw new TenantScopeError('duplicate_registration', 'this model is already tenant-scoped');
    }
    shared.registry.set(model, column);
    // Invalidates every cached lookup, so a model queried before its
    // registration ran is not remembered as unscoped.
    shared.generation += 1;
    const prototype = model.prototype as object;
    Object.defineProperty(prototype, STAMP_METHOD, {
      value: function stampTenant(this: Record<string, unknown>): void {
        const state = tenantScopeState();
        if (state.unscoped) return;
        if (state.tenantId === undefined) throw noTenant();
        const current = this[column];
        if (current === undefined || current === null) {
          this[column] = state.tenantId;
        } else if (!sameTenant(current, state.tenantId)) {
          throw mismatch();
        }
      },
      configurable: true,
      writable: true,
    });
    BeforeInsert()(prototype, STAMP_METHOD);
  };
}

/** The tenant column for an entity's metadata, or `undefined` when it is not scoped. */
function scopedColumn(metadata: EntityMetadata): ColumnMetadata | undefined {
  if (shared.generation === 0) return undefined;
  const cached = shared.columns.get(metadata);
  if (cached !== undefined && cached.generation === shared.generation) {
    return cached.column ?? undefined;
  }
  const target = metadata.target;
  const property = typeof target === 'function' ? tenantScopeColumn(target) : undefined;
  let column: ColumnMetadata | null = null;
  if (property !== undefined) {
    const found = metadata.findColumnWithPropertyName(property);
    if (found === undefined || found.embeddedMetadata !== undefined) {
      throw new TenantScopeError(
        'invalid_column',
        'the tenant column must be a top-level column of the model',
      );
    }
    column = found;
  }
  shared.columns.set(metadata, { generation: shared.generation, column });
  return column ?? undefined;
}

/**
 * Every tenant value a value set writes: the tenant property itself, and the
 * referenced key of any relation whose join column is the tenant column.
 */
function writtenTenantValues(
  metadata: EntityMetadata,
  column: ColumnMetadata,
  valueSet: ObjectLiteral,
): unknown[] {
  const values: unknown[] = [];
  const own: unknown = valueSet[column.propertyName];
  if (own !== undefined) values.push(own);
  for (const relation of metadata.relationsWithJoinColumns) {
    const related: unknown = valueSet[relation.propertyName];
    if (related === undefined) continue;
    for (const joinColumn of relation.joinColumns) {
      if (joinColumn.databaseName !== column.databaseName) continue;
      if (related !== null && typeof related === 'object') {
        const referenced: unknown = joinColumn.referencedColumn?.getEntityValue(related);
        if (referenced !== undefined) values.push(referenced);
      } else {
        values.push(related);
      }
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Query-builder hooks
// ---------------------------------------------------------------------------

/** The parts of TypeORM's Alias the guard reads. */
interface AliasView {
  readonly type: string;
  readonly name: string;
  readonly hasMetadata: boolean;
  readonly metadata: EntityMetadata;
}

/** The parts of TypeORM's QueryExpressionMap the guard reads and writes. */
interface ExpressionMapView {
  queryType: string;
  mainAlias?: AliasView;
  readonly aliases: readonly AliasView[];
  readonly subQuery: boolean;
  aliasNamePrefixingEnabled: boolean;
  extraAppendedAndWhereCondition: string;
  valuesSet?: ObjectLiteral | ObjectLiteral[];
  onUpdate?: unknown;
  insertFromSelect?: unknown;
  cache?: boolean;
}

/** The parts of TypeORM's DataSource the guard reads. */
interface DataSourceView {
  readonly queryResultCache?: unknown;
  readonly options: { readonly cache?: unknown };
}

/** The builder surface the hooks run against. */
interface GuardedBuilder {
  readonly expressionMap: ExpressionMapView;
  readonly parentQueryBuilder?: unknown;
  readonly dataSource: DataSourceView;
  setParameter(key: string, value: unknown): unknown;
}

/** The JoinAttributeTree node `createJoinTreeRecursively` receives. */
interface JoinTreeView {
  readonly joinAttribute: {
    readonly alias: { readonly name: string };
    condition?: string;
    readonly metadata: EntityMetadata | undefined;
  };
}

interface WhereHookTarget {
  createWhereExpression(this: GuardedBuilder): string;
}

interface JoinHookTarget {
  createJoinTreeRecursively(this: GuardedBuilder, tree: JoinTreeView): string;
}

interface InsertHookTarget {
  getValueSets(this: GuardedBuilder): ObjectLiteral[];
}

const FILTERED_QUERY_TYPES = new Set(['select', 'update', 'delete', 'soft-delete', 'restore']);

/**
 * Whether `builder` renders a subquery, whose SQL is generated when the outer
 * query is built and whose parameters belong to the outer builder.
 */
function isSubquery(builder: GuardedBuilder): boolean {
  return (
    builder.expressionMap.subQuery ||
    (builder.parentQueryBuilder !== undefined && builder.parentQueryBuilder !== null)
  );
}

/**
 * Bind the ambient state for any subquery condition this outer builder's SQL
 * contains. Runs every time the builder generates SQL, so a reused builder
 * always carries the state current when it runs. With no tenant the id is
 * `null` and the "present" flag 0, so the condition matches nothing.
 */
function bindScopeParameters(builder: GuardedBuilder, state: TenantScopeState): void {
  builder.setParameter(OFF_PARAMETER, state.unscoped ? 1 : 0);
  builder.setParameter(ON_PARAMETER, state.tenantId === undefined ? 0 : 1);
  builder.setParameter(TENANT_PARAMETER, state.tenantId ?? null);
}

/** The tenant filter on `prefix<column>` for SQL generated as the query runs. */
function tenantCondition(
  prefix: string,
  column: ColumnMetadata,
  tenantId: TenantId | undefined,
): string {
  if (tenantId === undefined) return '1 = 0';
  return `${prefix}${column.propertyPath} = :${TENANT_PARAMETER}`;
}

/**
 * The tenant filter for a subquery: it holds no state of its own and reads
 * only the parameters the outer builder binds when it runs.
 */
function subqueryCondition(prefix: string, column: ColumnMetadata): string {
  return (
    `(:${OFF_PARAMETER} = 1 OR (:${ON_PARAMETER} = 1 AND ` +
    `${prefix}${column.propertyPath} = :${TENANT_PARAMETER}))`
  );
}

/** The aliases a WHERE filter covers: the main table and every `addFrom` table. */
function filteredAliases(map: ExpressionMapView): AliasView[] {
  const main = map.mainAlias;
  const aliases = main === undefined ? [] : [main];
  for (const alias of map.aliases) {
    // By name: a cloned expression map copies the main alias and its entry
    // in `aliases` into separate objects.
    if (alias.type === 'from' && alias.name !== main?.name) aliases.push(alias);
  }
  return aliases.filter((alias) => alias.hasMetadata);
}

/**
 * Whether TypeORM would answer this SELECT from its query result cache: the
 * data source has a cache and the query opts in (`.cache()`, `find({ cache })`)
 * or the cache is always on.
 */
function servedFromResultCache(builder: GuardedBuilder): boolean {
  const { dataSource, expressionMap } = builder;
  if (dataSource.queryResultCache === undefined || dataSource.queryResultCache === null) {
    return false;
  }
  if (expressionMap.cache === true) return true;
  const options = dataSource.options.cache;
  return (
    options !== null &&
    typeof options === 'object' &&
    (options as { alwaysEnabled?: unknown }).alwaysEnabled === true
  );
}

function assertUpdateKeepsTenant(
  metadata: EntityMetadata,
  column: ColumnMetadata,
  valuesSet: ObjectLiteral | ObjectLiteral[] | undefined,
  tenantId: TenantId,
): void {
  if (valuesSet === undefined) return;
  for (const valueSet of Array.isArray(valuesSet) ? valuesSet : [valuesSet]) {
    for (const value of writtenTenantValues(metadata, column, valueSet)) {
      if (!sameTenant(value, tenantId)) throw mismatch();
    }
  }
}

function stampInsert(
  metadata: EntityMetadata,
  column: ColumnMetadata,
  valueSet: ObjectLiteral,
  tenantId: TenantId,
): void {
  const written = writtenTenantValues(metadata, column, valueSet).filter((value) => value !== null);
  for (const value of written) {
    if (!sameTenant(value, tenantId)) throw mismatch();
  }
  const own: unknown = valueSet[column.propertyName];
  if (own === undefined || own === null) {
    valueSet[column.propertyName] = tenantId;
  }
}

const INSTALLED = Symbol.for('jsails.tenantScopeGuard');

function installGuard(): void {
  const marker = QueryBuilder.prototype as unknown as Record<symbol, boolean>;
  if (marker[INSTALLED] === true) return;
  marker[INSTALLED] = true;

  const whereTarget = QueryBuilder.prototype as unknown as WhereHookTarget;
  const originalWhere = whereTarget.createWhereExpression;
  whereTarget.createWhereExpression = function (this: GuardedBuilder): string {
    if (shared.generation === 0) return originalWhere.call(this);
    const map = this.expressionMap;
    const state = tenantScopeState();
    const subquery = isSubquery(this);
    if (!subquery) bindScopeParameters(this, state);
    if (!FILTERED_QUERY_TYPES.has(map.queryType)) return originalWhere.call(this);
    const conditions: string[] = [];
    for (const alias of filteredAliases(map)) {
      const column = scopedColumn(alias.metadata);
      if (column === undefined) continue;
      const main = alias === map.mainAlias;
      const prefix = !main || map.aliasNamePrefixingEnabled ? `${alias.name}.` : '';
      if (subquery) {
        conditions.push(subqueryCondition(prefix, column));
        continue;
      }
      if (state.unscoped) continue;
      if (map.queryType === 'select' && servedFromResultCache(this)) {
        throw new TenantScopeError(
          'unsupported_query',
          'the query result cache is not supported on a tenant-scoped model',
        );
      }
      if (map.queryType !== 'select') {
        if (state.tenantId === undefined) throw noTenant();
        if (main && map.queryType === 'update') {
          assertUpdateKeepsTenant(alias.metadata, column, map.valuesSet, state.tenantId);
        }
      }
      conditions.push(tenantCondition(prefix, column, state.tenantId));
    }
    if (conditions.length === 0) return originalWhere.call(this);
    const condition = conditions.map((part) => `(${part})`).join(' AND ');
    const previous = map.extraAppendedAndWhereCondition;
    map.extraAppendedAndWhereCondition = previous ? `(${previous}) AND ${condition}` : condition;
    try {
      return originalWhere.call(this);
    } finally {
      map.extraAppendedAndWhereCondition = previous;
    }
  };

  const joinTarget = SelectQueryBuilder.prototype as unknown as JoinHookTarget;
  const originalJoin = joinTarget.createJoinTreeRecursively;
  joinTarget.createJoinTreeRecursively = function (this: GuardedBuilder, tree: JoinTreeView) {
    const join = tree.joinAttribute;
    const metadata = join.metadata;
    const column = metadata === undefined ? undefined : scopedColumn(metadata);
    if (column === undefined) return originalJoin.call(this, tree);
    const prefix = `${join.alias.name}.`;
    let condition: string;
    if (isSubquery(this)) {
      condition = subqueryCondition(prefix, column);
    } else {
      // The tenant id parameter is bound by this builder's WHERE hook, which
      // runs later in the same SQL generation.
      const state = tenantScopeState();
      if (state.unscoped) return originalJoin.call(this, tree);
      condition = tenantCondition(prefix, column, state.tenantId);
    }
    const previous = join.condition;
    join.condition = previous ? `(${previous}) AND (${condition})` : condition;
    try {
      return originalJoin.call(this, tree);
    } finally {
      join.condition = previous;
    }
  };

  const insertTarget = InsertQueryBuilder.prototype as unknown as InsertHookTarget;
  const originalValueSets = insertTarget.getValueSets;
  insertTarget.getValueSets = function (this: GuardedBuilder): ObjectLiteral[] {
    const map = this.expressionMap;
    const alias = map.mainAlias;
    const column =
      alias === undefined || !alias.hasMetadata ? undefined : scopedColumn(alias.metadata);
    const state = tenantScopeState();
    // An INSERT renders no WHERE, so the parameters a subquery among its
    // values may read are bound here.
    if (shared.generation > 0 && !isSubquery(this)) bindScopeParameters(this, state);
    if (alias === undefined || column === undefined || state.unscoped) {
      return originalValueSets.call(this);
    }
    if (state.tenantId === undefined) throw noTenant();
    if (map.onUpdate !== undefined || map.insertFromSelect !== undefined) {
      throw new TenantScopeError(
        'unsupported_write',
        'upserts and INSERT ... SELECT are not supported on a tenant-scoped model',
      );
    }
    const valueSets = originalValueSets.call(this);
    for (const valueSet of valueSets) {
      stampInsert(alias.metadata, column, valueSet, state.tenantId);
    }
    return valueSets;
  };
}

installGuard();
