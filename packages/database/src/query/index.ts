/**
 * The query layer: `ModelQuery`, the immutable query over one model (with
 * relation filters, scopes and keyset batch walks), `query(model)` and
 * `insertAll(model, rows)` for any model or table, `defineScope`, and the
 * `WriteResult` of a set write.
 */

export {
  defineScope,
  insertAll,
  ModelQuery,
  query,
  type CountComparison,
  type QueryLock,
  type QueryState,
  type RelationFilter,
  type ScopedRow,
  type ScopeFunction,
} from './model-query.js';
export type { QueryContext, WriteResult } from './query-context.js';
export { QueryErrors } from './query-errors.js';
