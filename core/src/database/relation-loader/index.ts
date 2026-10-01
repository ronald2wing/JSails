/**
 * The batch relation loader barrel: the load options types and the
 * `loadRelation`/`loadRelations` entry points.
 */

export {
  type RelationLoadSpec,
  type RelationLoadOptions,
  type LoadRelationsOptions,
} from './load-options.js';
export { loadRelation, loadRelations } from './load-relation.js';
