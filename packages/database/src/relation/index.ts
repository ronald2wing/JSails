/**
 * Relation loading: one statement per relation level per bind chunk, a
 * per-parent `limit` as a window, the grouping key read from the row itself,
 * and relations that are either loaded or throw (`relation.not_loaded`),
 * never silently empty. A query loads relations with its records through
 * `includes`; `loadRelation`, `loadRelationMap` and `relationCount` load
 * them for records or rows in hand. A record class declares a relation as
 * `Relation<V>`, and `Loaded<T, S>` is the type of a record whose relations
 * `S` were loaded.
 */

export type { IncludeNode } from './includes.js';
export { RelationErrors } from './relation-errors.js';
export {
  loadRelation,
  loadRelationMap,
  relationCount,
  type RelationCountOptions,
} from './relation-loaders.js';
export type {
  IncludeSpec,
  IncludeTree,
  Loaded,
  NotLoaded,
  Relation,
  RelationKey,
  RelationLoadOptions,
  RelationTarget,
  RelationValue,
} from './relation-types.js';
