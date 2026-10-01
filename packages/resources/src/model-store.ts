/**
 * The `ResourceStore` a model resource runs on: every query is the resource's
 * row scope AND the request's allowlisted filters, built only through the
 * validating `jsails/database` constructors.
 *
 * - `count` and `list` build one fresh predicate per call from the same
 *   scope and query, so the page count always describes the page.
 * - `get`, `update`, and `delete` add the scope to the primary-key lookup. A
 *   row outside the scope and a row that does not exist are the same `null`,
 *   so the handler answers 404 for both and a client cannot probe for ids it
 *   may not see. A malformed id is `null` too, before any query runs.
 * - Writes copy only writable fields off the already-validated input, then
 *   apply `stamp`, so a server-owned value such as an owner id can never come
 *   from the request body.
 * - Before a write is saved, every unique constraint the resource can fill is
 *   checked, as Django REST framework's unique validators do: a duplicate is a
 *   `400` on the field (or on the whole body for a multi-column constraint)
 *   instead of a database error. The lookup spans the whole table, not the
 *   row scope, because the constraint does. A concurrent duplicate that slips
 *   past the check fails in the database; the store then checks again, finds
 *   the row that won, and answers the same `400`.
 * - Writes the resource's `actions` leave out are refused here too, so the
 *   store is safe to hand to another surface such as an admin resource.
 * - Sorts and filters are re-checked against the allowlist here, so the store
 *   stays safe even if a caller hands it a query the handlers did not parse.
 */

import type { RequestContext } from 'jsails';
import {
  ValidationError,
  type ResourceAction,
  type ValidationIssue,
  type FilterClause,
  type FilterOptions,
  type NormalizedQuery,
  type ResourceStore,
  type SortClause,
} from 'jsails/api';
import {
  and,
  isUniqueViolation,
  or,
  qContains,
  qEq,
  qGt,
  qGte,
  qIn,
  qLt,
  qLte,
  qNe,
  qNotIn,
  query,
  type ModelQuery,
  type Q,
} from 'jsails/database';
import type { BaseEntity } from 'jsails/models';

import type { PrimaryKeyKind } from './model-columns.js';
import { ModelResourceError } from './resource-error.js';
import type { Awaitable, ModelScope, ModelUnscoped } from './scope.js';

/**
 * Server-owned values set on every created row: one function per column, so
 * the stamped columns are known when the resource is defined.
 */
export type ModelStamp = Readonly<Record<string, (context: RequestContext) => Awaitable<unknown>>>;

/** Everything the store needs, already validated by `defineModelResource`. */
export interface ModelStoreSpec<M extends BaseEntity> {
  readonly model: (new () => M) & typeof BaseEntity;
  readonly scope: ModelScope | ModelUnscoped;
  readonly filters: FilterOptions;
  readonly writable: ReadonlySet<string>;
  readonly searchable: readonly string[];
  readonly primaryKey: PrimaryKeyKind;
  /** The actions the resource serves; a write outside them is refused. */
  readonly actions: ReadonlySet<ResourceAction>;
  /** Unique constraints whose every column the resource writes or stamps. */
  readonly unique: readonly (readonly string[])[];
  readonly defaultSort: readonly SortClause[];
  readonly stamp?: ModelStamp;
}

/** The scope's predicate for this request, `undefined` for every row, `null` for none. */
type ResolvedScope = Q | undefined | null;

const INTEGER_ID = /^[1-9][0-9]*$/;
const STRING_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Build the store for a validated model resource spec. */
export function createModelStore<M extends BaseEntity>(
  spec: ModelStoreSpec<M>,
): ResourceStore<M, Record<string, unknown>, Record<string, unknown>> {
  const { model, filters, writable, searchable } = spec;

  async function resolveScope(context: RequestContext): Promise<ResolvedScope> {
    return spec.scope.kind === 'unscoped' ? undefined : spec.scope.where(context);
  }

  /** The scoped base query, or `null` when the scope admits no rows. */
  async function scoped(context: RequestContext): Promise<ModelQuery<M> | null> {
    const scope = await resolveScope(context);
    if (scope === null) return null;
    const builder = query<M>(model);
    if (scope !== undefined) builder.where(scope);
    return builder;
  }

  /** The scoped query narrowed by the request's search and filters. */
  async function narrowed(
    context: RequestContext,
    request: NormalizedQuery,
  ): Promise<ModelQuery<M> | null> {
    const builder = await scoped(context);
    if (builder === null) return null;
    if (request.search !== null) {
      if (searchable.length === 0) {
        throw new ValidationError([
          {
            path: ['search'],
            code: 'search_unsupported',
            message: 'This resource is not searchable',
          },
        ]);
      }
      const term = request.search;
      const matches = searchable.map((field) => qContains(field, term));
      builder.where(matches.length === 1 ? matches[0]! : or(...matches));
    }
    const clauses = request.filterClauses.map((clause) => predicate(clause, filters));
    if (clauses.length > 0) builder.where(clauses.length === 1 ? clauses[0]! : and(...clauses));
    return builder;
  }

  /** The id as its column type, or `null` when it cannot name a row. */
  function parseId(id: string): number | string | null {
    if (spec.primaryKey === 'string') return STRING_ID.test(id) ? id : null;
    if (!INTEGER_ID.test(id)) return null;
    const value = Number(id);
    return Number.isSafeInteger(value) ? value : null;
  }

  async function findScoped(id: string, context: RequestContext): Promise<M | null> {
    const key = parseId(id);
    if (key === null) return null;
    const builder = await scoped(context);
    if (builder === null) return null;
    return builder.where(qEq('id', key)).getOne();
  }

  function copyWritable(target: M, data: Readonly<Record<string, unknown>>): void {
    const record = target as unknown as Record<string, unknown>;
    for (const name of writable) {
      if (Object.hasOwn(data, name)) record[name] = data[name];
    }
  }

  async function applyStamp(target: M, context: RequestContext): Promise<void> {
    if (spec.stamp === undefined) return;
    const record = target as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(spec.stamp)) {
      record[name] = await value(context);
    }
  }

  function assertAction(action: ResourceAction): void {
    if (!spec.actions.has(action)) {
      throw new ModelResourceError('action_not_allowed', 'the resource does not serve this action');
    }
  }

  /**
   * Refuse a write that would duplicate a unique constraint. On update only
   * the constraints a changed column belongs to are checked. A constraint with
   * a null or unset column is skipped: SQL treats nulls as distinct.
   */
  async function assertUnique(row: M, changed: ReadonlySet<string> | null): Promise<void> {
    const record = row as unknown as Record<string, unknown>;
    const issues: ValidationIssue[] = [];
    for (const columns of spec.unique) {
      if (changed !== null && !columns.some((column) => changed.has(column))) continue;
      const values = columns.map((column) => record[column]);
      if (values.some((value) => value === undefined || value === null)) continue;
      const builder = query<M>(model);
      for (const [index, column] of columns.entries()) builder.where(qEq(column, values[index]));
      const id = record['id'];
      if (id !== undefined && id !== null) builder.where(qNe('id', id));
      if ((await builder.count()) === 0) continue;
      issues.push(
        columns.length === 1
          ? { path: [columns[0]!], code: 'unique', message: 'This field must be unique' }
          : {
              path: [],
              code: 'unique',
              message: `The fields ${columns.join(', ')} must make a unique set`,
            },
      );
    }
    if (issues.length > 0) throw new ValidationError(issues);
  }

  /**
   * Save, answering a unique violation from a concurrent writer like the
   * check: the winning row now exists, so checking again names the field. A
   * violation of a constraint the resource does not fill is not the client's
   * to fix and is rethrown.
   */
  async function save(row: M): Promise<void> {
    try {
      await row.save();
    } catch (error) {
      if (isUniqueViolation(error)) await assertUnique(row, null);
      throw error;
    }
  }

  return {
    async count(context, request) {
      const builder = await narrowed(context, request);
      return builder === null ? 0 : builder.count();
    },

    async list(offset, limit, context, request) {
      const builder = await narrowed(context, request);
      if (builder === null) return [];
      const sorts = request.sorts.length > 0 ? request.sorts : spec.defaultSort;
      for (const sort of sorts) {
        if (!isAllowed(filters, sort.field, 'sortable')) {
          throw new ModelResourceError('invalid_sort', 'a sort must name a sortable field');
        }
        builder.orderBy(sort.field, sort.direction === 'desc' ? 'DESC' : 'ASC');
      }
      // A stable tiebreaker keeps rows from repeating or vanishing across pages.
      if (!sorts.some((sort) => sort.field === 'id')) builder.orderBy('id', 'ASC');
      return builder.offset(offset).limit(limit).getMany();
    },

    get: (id, context) => findScoped(id, context),

    async create(data, context) {
      assertAction('create');
      const row = new model();
      copyWritable(row, data);
      await applyStamp(row, context);
      await assertUnique(row, null);
      await save(row);
      return row;
    },

    async update(id, data, context) {
      assertAction('update');
      const row = await findScoped(id, context);
      if (row === null) return null;
      copyWritable(row, data);
      await assertUnique(row, new Set(Object.keys(data).filter((name) => writable.has(name))));
      await save(row);
      return row;
    },

    async delete(id, context) {
      assertAction('delete');
      const row = await findScoped(id, context);
      if (row !== null) await row.remove();
    },
  };
}

function isAllowed(
  filters: FilterOptions,
  field: string,
  flag: 'sortable' | 'filterable',
): boolean {
  return Object.hasOwn(filters.fields, field) && filters.fields[field]?.[flag] === true;
}

/** One allowlisted filter clause as a validated predicate. */
function predicate(clause: FilterClause, filters: FilterOptions): Q {
  const { field, value } = clause;
  if (!isAllowed(filters, field, 'filterable')) {
    throw new ModelResourceError('invalid_field', 'a filter must name a filterable field');
  }
  const values = Array.isArray(value) ? value : [value];
  switch (clause.operator) {
    case 'eq':
      return qEq(field, value);
    case 'neq':
      return qNe(field, value);
    case 'gt':
      return qGt(field, value);
    case 'gte':
      return qGte(field, value);
    case 'lt':
      return qLt(field, value);
    case 'lte':
      return qLte(field, value);
    case 'in':
      return qIn(field, values);
    case 'nin':
      return qNotIn(field, values);
  }
}
