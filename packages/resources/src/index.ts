/**
 * `@jsails/resources`: model-backed API resources. `defineModelResource`
 * turns a model and one explicit field allowlist into a serializer, a
 * row-scoped store, and the `jsails/api` resource handlers.
 */

export {
  defineModelResource,
  type ModelClass,
  type ModelResource,
  type ModelResourceOptions,
} from './model-resource.js';
export {
  type FieldAccess,
  type ModelField,
  type ModelFieldFilter,
  type ModelFields,
  type SerializerFieldOf,
  type SerializerFieldsOf,
} from './model-fields.js';
export type { ModelStamp } from './model-store.js';
export {
  scopedBy,
  unscoped,
  type Awaitable,
  type ModelScope,
  type ModelUnscoped,
} from './scope.js';
export { ModelResourceError, type ModelResourceErrorCode } from './resource-error.js';
