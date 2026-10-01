/**
 * The guarded compile: the only way the data layer turns a statement into
 * SQL for app code. It reads the ambient tenant scope, applies the policy
 * (`applyPolicies`) against the catalog, and renders the result for the
 * catalog's dialect. `Engine.compile` stays the raw renderer: it is pure,
 * knows no models, and is what `unguarded` and the schema tools use; the
 * data source keeps its engine private, so app statements reach the database
 * through here.
 *
 * A statement `withoutTenantScope` lets through on a tenant-scoped table
 * carries the origin {@link TENANT_UNSCOPED_ORIGIN}, which
 * {@link executeStatement} records in the query ledger whatever origin the
 * caller asked for, so every opt-out shows there.
 */

import type { Conn, QueryOptions, QueryResult } from '../engine/contract.js';
import { compileStatement } from '../engine/render.js';
import type { CompiledStatement, Statement } from '../engine/statement.js';
import { applyPolicies, touchesTenantTable } from './apply-policies.js';
import type { StatementCatalog } from './statement-catalog.js';
import {
  currentTenantScope,
  TENANT_UNSCOPED_ORIGIN,
  type TenantScopeState,
} from './tenant-scope.js';

/** A rendered statement with the ledger origin its policy decided, if any. */
export interface GuardedStatement extends CompiledStatement {
  /** {@link TENANT_UNSCOPED_ORIGIN} when the tenant scope was off for a tenant-scoped table. */
  readonly origin?: string;
}

/**
 * Render `statement` for the catalog's dialect with the tenant policy of
 * `scope` (the ambient scope when omitted) applied.
 *
 * @throws `statement.unknown_table`, the `tenant_scope.*` codes of
 *   `applyPolicies`, and the engine's `invalid_statement`,
 *   `unsupported_statement` and `too_many_parameters`.
 */
export function compileGuarded(
  catalog: StatementCatalog,
  statement: Statement,
  scope: TenantScopeState = currentTenantScope(),
): GuardedStatement {
  const guarded = applyPolicies(statement, { tables: catalog, scope });
  const compiled = compileStatement(guarded, catalog.dialect);
  if (scope.unscoped && touchesTenantTable(guarded, catalog)) {
    return Object.freeze({ ...compiled, origin: TENANT_UNSCOPED_ORIGIN });
  }
  return compiled;
}

/**
 * Compile `statement` through {@link compileGuarded} under the ambient scope
 * and run it on `conn`. A compile failure rejects before anything is sent.
 */
export async function executeStatement(
  conn: Conn,
  catalog: StatementCatalog,
  statement: Statement,
  options: QueryOptions = {},
): Promise<QueryResult> {
  const compiled = compileGuarded(catalog, statement);
  const origin = compiled.origin ?? options.origin;
  return conn.query(compiled.sql, compiled.params, origin === undefined ? {} : { origin });
}
