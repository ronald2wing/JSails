/**
 * Store-backed admin resource: a factory that derives a `Resource` descriptor
 * from a `ResourceStore` + `Serializer`, synthesizing `list`/`get`/`save`
 * callbacks so a store-backed admin CRUD shares the same store and serializer
 * as the API side.
 *
 * ## Store call adaptation
 *
 * The admin resource callbacks receive admin-specific context types
 * (`ResourceListContext`, `ResourceGetContext`, `ResourceSaveContext`), which
 * carry a `Session` but not a full `RequestContext`. The store methods expect
 * `RequestContext`. A minimal `RequestContext` is synthesized from the session
 * so the store's row-scoping (which reads `context.session`) works correctly.
 * Stores that depend on other `RequestContext` fields (e.g. the request URL)
 * should use a hand-written resource descriptor instead.
 *
 * ## Sort, search, and filter
 *
 * The admin list context's sort, direction, search term, and `f_<name>` select
 * filters become one `NormalizedQuery` handed to both `store.count` and
 * `store.list`, the same shape the API's collection `GET` passes. The admin
 * list route has already restricted each of them to the columns marked
 * `sortable`, `searchable`, or filterable, so the store sees only names the
 * resource declared. Select filters become `eq` clauses. Their values arrive as
 * strings; pass the API resource's `filters` options and each value is coerced
 * to its declared type exactly as the API coerces it, so a store shared with
 * the API compares `true` and `3` from both sides rather than `'true'` and
 * `'3'` from this one. Every admin filter must then be declared there, and a
 * value that does not coerce is the same value-free `ValidationError`.
 *
 * ## Writes
 *
 * A save runs the form values through `serializer.validate` (partially, for an
 * update) before the store sees them, so the serializer is the write allowlist
 * on the admin side exactly as on the API side: a read-only or undeclared key
 * is rejected rather than persisted. A rejection is the serializer's
 * value-free `ValidationError`, which the form route renders as a 422.
 */

import type { RequestContext, Session } from 'jsails';
import {
  DEFAULT_PAGE_SIZE,
  parseFilters,
  type FilterClause,
  type FilterOptions,
  type NormalizedQuery,
  type ResourceStore,
  type Serializer,
} from 'jsails/api';
import { isRecord } from 'jsails/plugin-sdk';

import { AdminDefinitionError } from '../errors.js';
import type { RelationManager } from '../relation-manager.js';
import type { ResourceColumn, ResourceInfolist } from './columns.js';
import type { ResourceField } from './field-types.js';
import {
  defineResource,
  type AdminResourceAuthorize,
  type Resource,
  type ResourceActions,
  type ResourceDefinition,
  type ResourceFileDiskResolver,
  type ResourceGetContext,
  type ResourceListContext,
  type ResourceListResult,
  type ResourceSaveContext,
} from './resource-descriptor.js';

/** Raise the store resource's value-free definition error. */
function invalid(message: string): AdminDefinitionError {
  return new AdminDefinitionError('invalid_store_resource', message);
}

/** Specification for {@link defineStoreResource}. */
export interface StoreResourceDefinition {
  /** URL identifier under the panel path (passed through to `defineResource`). */
  readonly slug: string;
  /** Persistence adapter shared with the API side. */
  readonly store: ResourceStore<any, any, any>;
  /** Serializer that maps records to allowlisted representations. */
  readonly serializer: Serializer<any, any>;
  /** Human label; defaults to `slug` when omitted. */
  readonly label?: string;
  /** List-table columns; defaults to a single generic `id` column. */
  readonly columns?: readonly ResourceColumn[];
  /** Form fields; defaults to an empty array (read-only default). */
  readonly fields?: readonly ResourceField[];
  /** Optional per-resource authorization. */
  readonly authorize?: AdminResourceAuthorize;
  /** Optional header/row/bulk actions. */
  readonly actions?: ResourceActions;
  /** Optional read-only detail section. */
  readonly infolist?: ResourceInfolist;
  /** Optional resolver for `file` field upload disks. */
  readonly resolveFileDisk?: ResourceFileDiskResolver;
  /** Optional relation managers. */
  readonly relationManagers?: readonly RelationManager[];
  /**
   * The API resource's filter options. When given, select-filter values are
   * coerced to each field's declared type before they reach the store.
   */
  readonly filters?: FilterOptions;
}

/**
 * Build a frozen admin `Resource` whose `list`/`get`/`save` callbacks are
 * synthesized from a `ResourceStore` and `Serializer`.
 *
 * The returned descriptor delegates to {@link defineResource}, so every
 * validation and freezing rule applies.
 */
export function defineStoreResource(spec: StoreResourceDefinition): Resource {
  validateSpec(spec);

  const { store, serializer } = spec;
  const label = spec.label ?? spec.slug;
  const columns: readonly ResourceColumn[] = spec.columns ?? [{ name: 'id', label: 'ID' }];
  const fields: readonly ResourceField[] = spec.fields ?? [];

  const list = async (ctx: ResourceListContext): Promise<ResourceListResult> => {
    const pageSize = ctx.pageSize > 0 ? ctx.pageSize : DEFAULT_PAGE_SIZE;
    const offset = (ctx.page - 1) * pageSize;
    const rc = synthesizeRequestContext(ctx.session);
    const query = listQuery(ctx, spec.filters);
    const [rows, total] = await Promise.all([
      store.list(offset, pageSize, rc, query),
      store.count(rc, query),
    ]);
    return {
      rows: rows.map((r) => serializer.toRepresentation(r) as Record<string, unknown>),
      total,
    };
  };

  const get = async (ctx: ResourceGetContext): Promise<Record<string, unknown> | null> => {
    const rc = synthesizeRequestContext(ctx.session);
    const record = await store.get(ctx.id, rc);
    if (record === null) return null;
    return serializer.toRepresentation(record) as Record<string, unknown>;
  };

  const save = async (ctx: ResourceSaveContext): Promise<void> => {
    const rc = synthesizeRequestContext(ctx.session);
    if (ctx.id === null) {
      await store.create(serializer.validate(ctx.values), rc);
    } else {
      await store.update(ctx.id, serializer.validate(ctx.values, { partial: true }), rc);
    }
  };

  const definition: ResourceDefinition = {
    slug: spec.slug,
    label,
    columns: [...columns],
    fields: [...fields],
    list,
    get,
    save,
    ...(spec.authorize === undefined ? {} : { authorize: spec.authorize }),
    ...(spec.actions === undefined ? {} : { actions: spec.actions }),
    ...(spec.infolist === undefined ? {} : { infolist: spec.infolist }),
    ...(spec.resolveFileDisk === undefined ? {} : { resolveFileDisk: spec.resolveFileDisk }),
    ...(spec.relationManagers === undefined ? {} : { relationManagers: spec.relationManagers }),
  };

  return defineResource(definition);
}

/** The admin list context's sort, search, and select filters as a store query. */
function listQuery(ctx: ResourceListContext, options: FilterOptions | undefined): NormalizedQuery {
  const { filters, filterClauses } = selectFilters(ctx.filters ?? {}, options);
  return Object.freeze({
    search: ctx.search === undefined || ctx.search === '' ? null : ctx.search,
    sorts: Object.freeze(
      ctx.sort === undefined ? [] : [{ field: ctx.sort, direction: ctx.direction ?? 'asc' }],
    ),
    filters: Object.freeze({ ...filters }),
    filterClauses: Object.freeze([...filterClauses]),
  });
}

/**
 * Select filters as `eq` clauses: coerced through the API's own parser when
 * filter options are given, kept as strings otherwise.
 */
function selectFilters(
  raw: Readonly<Record<string, string>>,
  options: FilterOptions | undefined,
): Pick<NormalizedQuery, 'filters' | 'filterClauses'> {
  const entries = Object.entries(raw);
  if (options === undefined || entries.length === 0) {
    const clauses: FilterClause[] = entries.map(([field, value]) => ({
      field,
      operator: 'eq',
      value,
    }));
    return { filters: raw, filterClauses: clauses };
  }
  const params = new URLSearchParams();
  for (const [field, value] of entries) {
    params.append(`filter[${field}]`, value);
  }
  const { filters, filterClauses } = parseFilters(params, options);
  return { filters, filterClauses };
}

/** Build a minimal `RequestContext` carrying only the session. */
function synthesizeRequestContext(session: Session): RequestContext {
  return {
    request: new Request('http://localhost/'),
    url: new URL('http://localhost/'),
    params: {},
    session,
  };
}

/** The `ResourceStore` methods the synthesized callbacks call. */
const STORE_METHODS = ['count', 'list', 'get', 'create', 'update', 'delete'] as const;

/** Validate the store-resource spec structure. */
function validateSpec(spec: StoreResourceDefinition): void {
  if (!isRecord(spec)) {
    throw invalid('defineStoreResource requires a spec object');
  }
  if (typeof spec.slug !== 'string' || spec.slug.trim() === '') {
    throw invalid('store resource slug must be a non-empty string');
  }
  const store: unknown = spec.store;
  if (!isRecord(store)) {
    throw invalid('store resource store must be an object');
  }
  if (STORE_METHODS.some((method) => typeof store[method] !== 'function')) {
    throw invalid('store resource store must implement the ResourceStore interface');
  }
  const serializer: unknown = spec.serializer;
  if (!isRecord(serializer)) {
    throw invalid('store resource serializer must be an object');
  }
  if (
    typeof serializer['toRepresentation'] !== 'function' ||
    typeof serializer['validate'] !== 'function'
  ) {
    throw invalid('store resource serializer must expose validate and toRepresentation');
  }
  if (spec.label !== undefined && (typeof spec.label !== 'string' || spec.label.trim() === '')) {
    throw invalid('store resource label must be a non-empty string when present');
  }
  if (spec.filters !== undefined && !isRecord(spec.filters)) {
    throw invalid('store resource filters must be an object when present');
  }
}
