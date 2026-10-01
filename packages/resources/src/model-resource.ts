/**
 * `defineModelResource`: a model plus one explicit field allowlist becomes an
 * API resource.
 *
 * It composes the `jsails/api` primitives rather than replacing them. The
 * allowlist yields the serializer and the filter options, the scope and the
 * allowlist yield the store, and all three go to `createResourceHandlers`, so
 * default-deny `authorize`, the fetch-then-authorize detail flow, the body
 * cap, and value-free errors stay defined in one place.
 *
 * Every safety decision is a required option or a rule that fails at
 * definition time: there is no default `authorize`, no default scope, and no
 * field is exposed, sorted, filtered, or searched unless it says so. The
 * result is frozen plain data, and its `store` and `serializer` can back an
 * admin resource through `defineStoreResource` as well.
 */

import {
  createResourceHandlers,
  defineSerializer,
  type FilterOptions,
  type PaginationOptions,
  jsonError,
  type ReadOutput,
  type ResourceAction,
  type ResourceAuthorize,
  type ResourceHandler,
  type ResourceHandlers,
  type ResourceStore,
  type Serializer,
  type SortClause,
  type WriteInput,
} from 'jsails/api';
import type { BaseEntity } from 'jsails/models';

import {
  encryptedFields,
  modelColumns,
  primaryKeyKind,
  uniqueConstraints,
  type ColumnFacts,
} from './model-columns.js';
import {
  assertDefaultSort,
  deriveFields,
  type ModelFields,
  type SerializerFieldsOf,
} from './model-fields.js';
import { createModelStore, type ModelStamp } from './model-store.js';
import { ModelResourceError } from './resource-error.js';
import type { ModelScope, ModelUnscoped } from './scope.js';

/** A model class: an entity constructor with the Active Record statics. */
export type ModelClass<M extends BaseEntity> = (new () => M) & typeof BaseEntity;

/** The options a model resource is defined from. */
export interface ModelResourceOptions<M extends BaseEntity, F extends ModelFields> {
  /** The resource name, a URL-safe segment. */
  readonly name: string;
  /** Every field the API reads or writes. An undeclared column is never touched. */
  readonly fields: F;
  /** Which rows a request may see. Required; `unscoped(reason)` opts out. */
  readonly scope: ModelScope | ModelUnscoped;
  /** Default-deny authorization; only an exact `true` allows. */
  readonly authorize: ResourceAuthorize<M>;
  /**
   * Server-owned values set on create, one function per column. A stamped
   * column must not be writable.
   */
  readonly stamp?: ModelStamp;
  /**
   * The actions the resource serves, like choosing a Django REST framework
   * viewset: all five by default (`ModelViewSet`), `['list', 'retrieve']` for
   * a read-only resource (`ReadOnlyModelViewSet`). A handler for an action left
   * out answers `405` with an `Allow` header, and the store refuses that write.
   */
  readonly actions?: readonly ResourceAction[];
  /** Encrypted columns allowed into the field list. They are never queryable. */
  readonly exposeEncrypted?: readonly (keyof F & string)[];
  /** The order when a request names none; `id` is always the final tiebreaker. */
  readonly defaultSort?: readonly SortClause[];
  /** Page size and offset caps. */
  readonly pagination?: PaginationOptions;
  /** Upper bound on a JSON request body, in bytes. */
  readonly maxJsonBytes?: number;
}

/** A defined model resource: frozen plain data. */
export interface ModelResource<M extends BaseEntity, TInput, TOutput> {
  readonly name: string;
  readonly model: ModelClass<M>;
  readonly serializer: Serializer<TInput, TOutput>;
  /** The filter options derived from the fields that opted in. */
  readonly filters: FilterOptions;
  /** The actions the resource serves. */
  readonly actions: readonly ResourceAction[];
  readonly store: ResourceStore<M, TInput, Partial<TInput>>;
  readonly authorize: ResourceAuthorize<M>;
  /** Mount `handlers.collection` and `handlers.detail` from `api/` route files. */
  readonly handlers: ResourceHandlers;
}

const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Define an API resource backed by `model` and the declared field allowlist. */
export function defineModelResource<M extends BaseEntity, const F extends ModelFields>(
  model: ModelClass<M>,
  options: ModelResourceOptions<M, F>,
): ModelResource<M, WriteInput<SerializerFieldsOf<F>>, ReadOutput<SerializerFieldsOf<F>>> {
  if (typeof model !== 'function') {
    throw new ModelResourceError('invalid_model', 'defineModelResource requires a model class');
  }
  if (options === null || typeof options !== 'object') {
    throw new ModelResourceError('invalid_fields', 'defineModelResource requires options');
  }
  const { name, fields, scope, authorize } = options;
  if (typeof name !== 'string' || !SEGMENT.test(name)) {
    throw new ModelResourceError('invalid_name', 'a resource name must be a URL-safe segment');
  }
  if (typeof authorize !== 'function') {
    throw new ModelResourceError('missing_authorize', 'a model resource requires authorize');
  }
  if (
    scope === null ||
    typeof scope !== 'object' ||
    (scope.kind !== 'scoped' && scope.kind !== 'unscoped')
  ) {
    throw new ModelResourceError(
      'missing_scope',
      'a model resource requires scopedBy(...) or unscoped(reason)',
    );
  }

  const columns = modelColumns(model);
  if (columns.size === 0) {
    throw new ModelResourceError('invalid_model', 'the model has no decorated columns');
  }
  const primary = [...columns].filter(([, facts]) => facts.primary).map(([column]) => column);
  if (primary.length !== 1 || primary[0] !== 'id') {
    throw new ModelResourceError(
      'missing_primary_key',
      'a model resource needs a single primary key column named id',
    );
  }

  const derived = deriveFields(
    fields,
    columns,
    encryptedFields(model),
    new Set(options.exposeEncrypted ?? []),
  );
  const stamped = stampedColumns(options.stamp, columns, derived.writable);
  const actions = resolveActions(options.actions);
  // As Django REST framework does, a constraint is checked only when the
  // resource supplies every column of it: from the body or from the stamp.
  const filled = (column: string): boolean => derived.writable.has(column) || stamped.has(column);
  const unique = uniqueConstraints(model).filter((set) => set.every(filled));
  const defaultSort = assertDefaultSort(options.defaultSort ?? [], derived.filters);
  const serializer = defineSerializer(derived.serializerFields as SerializerFieldsOf<F>);
  const store = createModelStore<M>({
    model,
    scope,
    filters: derived.filters,
    writable: derived.writable,
    searchable: derived.searchable,
    primaryKey: primaryKeyKind(model),
    actions,
    unique,
    defaultSort,
    ...(options.stamp === undefined ? {} : { stamp: Object.freeze({ ...options.stamp }) }),
  });
  const served = createResourceHandlers({
    serializer,
    store,
    authorize,
    filters: derived.filters,
    ...(options.pagination === undefined ? {} : { pagination: options.pagination }),
    ...(options.maxJsonBytes === undefined ? {} : { maxJsonBytes: options.maxJsonBytes }),
  });

  const handlers = restrictHandlers(served, actions);

  return Object.freeze({
    name,
    model,
    serializer,
    filters: derived.filters,
    actions: Object.freeze(ACTIONS.filter((action) => actions.has(action))),
    store,
    authorize,
    handlers,
  });
}

/** The columns `stamp` fills, after checking each names a column the client cannot write. */
function stampedColumns(
  stamp: ModelStamp | undefined,
  columns: ReadonlyMap<string, ColumnFacts>,
  writable: ReadonlySet<string>,
): ReadonlySet<string> {
  if (stamp === undefined) return new Set();
  if (stamp === null || typeof stamp !== 'object' || Array.isArray(stamp)) {
    throw new ModelResourceError('invalid_stamp', 'stamp must map columns to functions');
  }
  for (const [name, value] of Object.entries(stamp)) {
    if (typeof value !== 'function') {
      throw new ModelResourceError('invalid_stamp', 'stamp must map columns to functions', name);
    }
    if (!columns.has(name)) {
      throw new ModelResourceError('unknown_column', 'a stamped field must name a column', name);
    }
    if (writable.has(name)) {
      throw new ModelResourceError(
        'stamped_field_writable',
        'a stamped field must not be writable by the client',
        name,
      );
    }
  }
  return new Set(Object.keys(stamp));
}

/** Every action, in route order. */
const ACTIONS: readonly ResourceAction[] = ['list', 'create', 'retrieve', 'update', 'delete'];

function resolveActions(value: readonly ResourceAction[] | undefined): ReadonlySet<ResourceAction> {
  if (value === undefined) return new Set(ACTIONS);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((action) => (ACTIONS as readonly unknown[]).includes(action))
  ) {
    throw new ModelResourceError(
      'invalid_actions',
      'actions must list at least one of list, create, retrieve, update, delete',
    );
  }
  return new Set(value);
}

/** Replace the handlers of the actions a resource does not serve with a 405. */
function restrictHandlers(
  handlers: ResourceHandlers,
  actions: ReadonlySet<ResourceAction>,
): ResourceHandlers {
  const allowCollection = methodsFor(actions, [
    ['GET', 'list'],
    ['POST', 'create'],
  ]);
  const allowDetail = methodsFor(actions, [
    ['GET', 'retrieve'],
    ['PATCH', 'update'],
    ['DELETE', 'delete'],
  ]);
  const notAllowed =
    (allow: string): ResourceHandler =>
    () =>
      jsonError(405, 'method_not_allowed', 'Method Not Allowed', { allow }, { allow });
  const pick = (action: ResourceAction, handler: ResourceHandler, allow: string) =>
    actions.has(action) ? handler : notAllowed(allow);
  return Object.freeze({
    collection: Object.freeze({
      GET: pick('list', handlers.collection.GET, allowCollection),
      POST: pick('create', handlers.collection.POST, allowCollection),
    }),
    detail: Object.freeze({
      GET: pick('retrieve', handlers.detail.GET, allowDetail),
      PATCH: pick('update', handlers.detail.PATCH, allowDetail),
      DELETE: pick('delete', handlers.detail.DELETE, allowDetail),
    }),
  });
}

function methodsFor(
  actions: ReadonlySet<ResourceAction>,
  routes: readonly (readonly [string, ResourceAction])[],
): string {
  return routes
    .filter(([, action]) => actions.has(action))
    .map(([method]) => method)
    .join(', ');
}
