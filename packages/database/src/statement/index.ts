/**
 * The statement layer over the engine's IR: builders (the `ir` namespace),
 * the statement catalog of a data source's models, the tenant policy as a
 * pure rewrite (`applyPolicies`) with its independent coverage checker, the
 * guarded compile every app statement goes through, the ambient tenant scope
 * (`runWithTenant`, `withoutTenantScope`), and the predicate compiler for
 * `Where<T>` and `Q` with the encoding of values to write.
 */

export {
  applyPolicies,
  assertKnownTables,
  touchesTenantTable,
  type PolicyContext,
} from './apply-policies.js';
/** The IR builders, as one namespace: `ir.select`, `ir.and`, `ir.eq`, ... */
export * as ir from './builders.js';
export { compileGuarded, executeStatement, type GuardedStatement } from './guarded-compile.js';
export {
  encodeAssignments,
  encodeInsertRows,
  type EncodedRows,
  type Values,
} from './model-values.js';
export { sameSqlValue } from './same-sql-value.js';
export {
  createStatementCatalog,
  type PolicyTables,
  type StatementCatalog,
  type StatementCatalogOptions,
  type TenantTable,
} from './statement-catalog.js';
export { StatementErrors, TenantScopeErrors } from './statement-errors.js';
export {
  forEachTableReference,
  tableReferences,
  type ReferencePosition,
  type TableReference,
} from './statement-walk.js';
export {
  findUnscopedReferences,
  type CoverageGap,
  type UnscopedReference,
} from './tenant-coverage.js';
export {
  currentTenantScope,
  runWithoutTenant,
  runWithTenant,
  TENANT_UNSCOPED_ORIGIN,
  withoutTenantScope,
  type TenantId,
  type TenantScopeState,
} from './tenant-scope.js';
export {
  compileOrder,
  compileWhere,
  modelColumns,
  Q,
  type ColumnKey,
  type ComparisonOperators,
  type Condition,
  type Operators,
  type OrderBy,
  type PatternOperators,
  type QNode,
  type Where,
  type WhereInput,
} from './where.js';
