/**
 * `@jsails/database/model`: ModelSpec, the only model declaration. It holds
 * the portable column types and their per-dialect codecs, `defineModel` and
 * `defineTable`, the spec validator, and `physicalTable`, the single
 * lowering of a model to a dialect's table. Nothing here opens a connection
 * or loads TypeORM, so build tools and the schema-portability gate import it
 * offline.
 */

export {
  defineModel,
  defineTable,
  MODEL_SPEC,
  modelDefinition,
  modelSpec,
} from './define-model.js';
export type { ModelClass, TableDefinition } from './define-model.js';
export {
  ENCRYPTION_ENVELOPE_OVERHEAD,
  ENCRYPTION_KEY_ID_MAX_BYTES,
  encryptedCapacity,
  encryptedStorage,
} from './encrypted-storage.js';
export {
  ColumnValueError,
  ModelSpecError,
  type ColumnValueErrorCode,
  type ModelSpecErrorCode,
  type ModelSpecErrorDetail,
} from './model-error.js';
export { foreignKeyName, indexName, snakeCase } from './model-naming.js';
export { column } from './model-spec.js';
export type {
  AttachmentSpec,
  BelongsToPolymorphicSpec,
  BelongsToSpec,
  ColumnDataContract,
  ColumnDefault,
  ColumnFactory,
  ColumnOptions,
  ColumnOrigin,
  ColumnSpec,
  ColumnValue,
  Dependent,
  EncryptionSpec,
  HasManySpec,
  HasManyThroughSpec,
  IndexSpec,
  ModelDefinition,
  ModelSpec,
  ModelTarget,
  NormalizedSpec,
  OnDelete,
  RelationSpec,
  ResolvedColumn,
  ResolvedIndex,
} from './model-spec.js';
export type {
  RecordBehavior,
  RecordHook,
  RecordHookContext,
  RecordHooks,
  RecordOperation,
} from '../record/hooks.js';
export type { RecordValidator } from '../record/validation.js';
export {
  physicalTable,
  physicalType,
  unindexedColumns,
  type ColumnDefaultState,
  type ColumnState,
  type ForeignKeyState,
  type IndexOrigin,
  type IndexState,
  type TableState,
} from './physical-table.js';
export {
  portableCodec,
  SQLITE_SCALED_DECIMAL_PRECISION,
  type PortableCodec,
} from './portable-codec.js';
export {
  compareCodePoints,
  compareValues,
  describeType,
  indexEntryBytes,
  indexKeyBytes,
  isOrdered,
  MAX_BINARY_LENGTH,
  MAX_DECIMAL_PRECISION,
  MAX_INDEX_KEY_BYTES,
  MAX_ROW_BYTES,
  MAX_STRING_LENGTH,
  PORTABLE_KINDS,
  portableType,
  sameType,
  type BigintType,
  type BinaryType,
  type BooleanType,
  type DateType,
  type DecimalType,
  type FloatType,
  type IdType,
  type IntegerType,
  type JsonType,
  type JsonValue,
  type PortableType,
  type PortableValue,
  type StringType,
  type TextType,
  type TimestampType,
  type TimeType,
  type UuidType,
} from './portable-type.js';
export { normalizeSpec, storedType } from './spec-validation.js';
