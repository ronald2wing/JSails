/**
 * The statement layer's error codes: `statement.*` for a statement the
 * guarded compiler or the predicate compiler refuses, and `tenant_scope.*`
 * for one the tenant policy refuses. Every message is fixed text; the context
 * holds only model, table and property names, an operator from a fixed list,
 * or a count, never a value, a tenant id or SQL.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const STATEMENT_ERRORS = {
  unknown_table: {
    kind: 'internal',
    message: 'the statement names table {table}, which no model of the catalog declares',
    context: { table: 'identifier' },
    suggestion: 'pass every model and link table the data source reads to its model list',
  },
  duplicate_table: {
    kind: 'internal',
    message: 'two models of the catalog declare table {table}',
    context: { table: 'identifier' },
  },
  invalid_catalog: {
    kind: 'internal',
    message: 'statement catalog option {field} is invalid',
    context: { field: 'identifier' },
  },
  unknown_column: {
    kind: 'internal',
    message: 'model {model} has no column {field}',
    context: { model: 'identifier', field: 'identifier' },
  },
  unsupported_predicate: {
    kind: 'internal',
    message: 'column {model}.{field} cannot be used with {operator}',
    context: {
      model: 'identifier',
      field: 'identifier',
      operator: ['eq', 'ne', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'like', 'orderBy'],
    },
    suggestion:
      'a json, random-encrypted or data-contract column supports only null tests; a deterministic encrypted column supports equality only',
  },
  invalid_where: {
    kind: 'internal',
    message: 'the condition on {model}.{field} is malformed',
    context: { model: 'identifier', field: 'identifier' },
    suggestion:
      'use a value, null, an array, or an object of eq, ne, lt, lte, gt, gte, in, notIn, like and isNull',
  },
  invalid_values: {
    kind: 'internal',
    message: 'the values written to {model} are malformed at {field}',
    context: { model: 'identifier', field: 'identifier' },
  },
} as const;

/**
 * The statement layer's codes: a table no catalog model declares, a catalog
 * that cannot be built, a `Where` that names an unknown column or applies an
 * operator its codec cannot answer, and malformed values to write.
 */
export const StatementErrors: ErrorRegistry<'statement', typeof STATEMENT_ERRORS> = defineErrors(
  'statement',
  STATEMENT_ERRORS,
);

const TENANT_SCOPE_ERRORS = {
  no_tenant: {
    kind: 'forbidden',
    message: 'a write touches tenant-scoped table {table} with no current tenant',
    context: { table: 'identifier' },
    suggestion:
      'run it inside runWithTenant(), or inside withoutTenantScope() when it deliberately spans tenants',
  },
  tenant_mismatch: {
    kind: 'forbidden',
    message: 'a row written to {table} names a tenant other than the current one',
    context: { table: 'identifier' },
  },
  tenant_assignment: {
    kind: 'forbidden',
    message: 'a write would change the tenant column of {table}',
    context: { table: 'identifier' },
  },
  upsert_without_tenant: {
    kind: 'internal',
    message:
      'an upsert on tenant-scoped table {table} has a conflict target without the tenant column',
    context: { table: 'identifier' },
    suggestion: 'make the conflict target a unique key that includes the tenant column',
  },
  invalid_tenant: {
    kind: 'invalid',
    message: 'the tenant id is not a value the tenant column of {table} stores',
    context: { table: 'identifier' },
  },
  invalid_tenant_id: {
    kind: 'invalid',
    message: 'a tenant id must be a non-empty string or a finite number',
  },
} as const;

/**
 * The tenant policy's codes: a write with no current tenant, a row or SET
 * naming another tenant, an upsert whose conflict target could reach another
 * tenant's row, and a tenant id the tenant column cannot store.
 */
export const TenantScopeErrors: ErrorRegistry<'tenant_scope', typeof TENANT_SCOPE_ERRORS> =
  defineErrors('tenant_scope', TENANT_SCOPE_ERRORS);
