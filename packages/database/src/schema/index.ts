/**
 * The schema core: owned introspection and DDL for SQLite, MariaDB and
 * PostgreSQL (no ORM), the schema ledger (ownership, data migrations, meta),
 * the verified session lock, the planner with per-operation classification
 * and approval digests, `pushSchema`/`diffSchema`, the test-database guard
 * and the boot digest check; with `defineSchemaConfig` and the
 * `db:push`/`db:diff` command modules it carries. The public subpath
 * `@jsails/database/schema`.
 */

export * from '../cli/index.js';

export { schemaDigest } from './declared-tables.js';
export { diffSchema, type DiffSchemaOptions } from './diff-schema.js';
export { emit } from './emit.js';
export { introspect } from './introspect.js';
export {
  pushSchema,
  type DeferredOperation,
  type PushReport,
  type PushSchemaOptions,
} from './push-schema.js';
export { SchemaErrors } from './schema-errors.js';
export {
  appliedDataMigrations,
  bootstrapLedger,
  DATA_MIGRATIONS_TABLE,
  readMeta,
  readOwnership,
  recordDataMigration,
  SCHEMA_META_TABLE,
  SCHEMA_OBJECTS_TABLE,
  writeMeta,
  type AppliedDataMigration,
} from './schema-ledger.js';
export type { Classification, SchemaOperation, SchemaOperationKind } from './schema-operation.js';
export {
  planSchema,
  type DeferralReason,
  type PlanInput,
  type PlannedOperation,
  type SchemaPlan,
} from './schema-plan.js';
export { APP_OWNER, type SchemaSource } from './schema-source.js';
export type {
  LiveColumn,
  LiveDefault,
  LiveForeignKey,
  LiveIndex,
  LiveTable,
  SchemaState,
} from './schema-state.js';
export {
  assertTestDatabase,
  connectedDatabase,
  isTestDatabaseName,
  markTestDatabase,
} from './test-guard.js';
export {
  verifySchema,
  type SchemaVerification,
  type VerifySchemaOptions,
} from './verify-schema.js';
