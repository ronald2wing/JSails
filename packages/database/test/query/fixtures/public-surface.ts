/**
 * The frozen public surface of records and queries: every method of
 * `ModelQuery`, every static and instance method of `ApplicationRecord`, and
 * every public member of `JsailsDataSource` and of `unguarded(ds)`. The
 * surface test compares the classes with these lists, so a method added or
 * removed is a change to this file, reviewed as such. The write pipeline
 * (DAT-08) reads these lists for the methods it must route through itself.
 */

/** `ModelQuery.prototype`, `constructor` excluded. */
export const MODEL_QUERY_METHODS: readonly string[] = Object.freeze([
  'count',
  'deleteAll',
  'exists',
  'findEach',
  'getMany',
  'getOne',
  'has',
  'inBatches',
  'includes',
  'limit',
  'lock',
  'offset',
  'orderBy',
  'pluck',
  'scope',
  'select',
  'updateAll',
  'where',
  'whereHas',
  'withoutTenantScope',
]);

/** The statics of `ApplicationRecord`. */
export const RECORD_STATICS: readonly string[] = Object.freeze([
  'all',
  'build',
  'create',
  'find',
  'findBy',
  'insertAll',
  'where',
]);

/** `ApplicationRecord.prototype`, `constructor` excluded. */
export const RECORD_METHODS: readonly string[] = Object.freeze([
  'changed',
  'destroy',
  'isPersisted',
  'reload',
  'save',
  'was',
]);

/** The public members of a `JsailsDataSource`, own and inherited, `constructor` excluded. */
export const DATA_SOURCE_MEMBERS: readonly string[] = Object.freeze([
  'changes',
  'close',
  'closed',
  'dialect',
  'models',
  'transaction',
  'withTestTransaction',
]);

/** The members of `unguarded(ds)`. */
export const UNGUARDED_MEMBERS: readonly string[] = Object.freeze(['lease', 'sql']);

/** The members of a model-set handle. */
export const DATA_HANDLE_MEMBERS: readonly string[] = Object.freeze([
  'insertAll',
  'query',
  'read',
  'transaction',
]);
