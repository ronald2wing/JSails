/**
 * The tenant coverage checker: given a statement as it will be compiled, it
 * reports every reference to a tenant-scoped table that the tenant
 * condition does not hold. It is written apart from the rewrite (it walks
 * with `statement-walk.ts` and reads conditions, never builds them), so a
 * test can hold any statement source, the policy's output included, to it:
 * the policy's own tests, and the coverage tests other packages add for
 * their link and search tables or publications.
 *
 * A reference is covered when the condition that scopes it has, among its
 * top-level `AND` terms, `qualifier.tenant = <current tenant>` or `1 = 0`.
 * With no current tenant (or one its column cannot store) that is not
 * enough, because a reference emptied under `NOT EXISTS`, `NOT IN`, `NOT`
 * or a left join still lets the statement reach every outer row: then a
 * reference is covered only when the statement as a whole is empty, its
 * outermost `WHERE` having `1 = 0` among its top-level terms. An insert is covered when
 * every row carries the current tenant; an upsert also needs the tenant
 * column in its conflict target, as a guard, and not among the updated
 * columns; an update's SET of the tenant column must be the current tenant
 * as a value, and the scalar subquery of a SET term is a reference like any
 * other.
 * Inside `withoutTenantScope` nothing is reported.
 */

import type { SqlValue } from '../engine/contract.js';
import type { InsertStatement, Predicate, Statement } from '../engine/statement.js';
import { sameSqlValue } from './same-sql-value.js';
import type { PolicyTables, TenantTable } from './statement-catalog.js';
import { forEachTableReference, type ReferencePosition } from './statement-walk.js';
import type { TenantScopeState } from './tenant-scope.js';

/** Why a reference is not covered. */
export type CoverageGap =
  /** Its scoping condition lacks the tenant condition. */
  | 'missing_condition'
  /** An inserted row does not carry the current tenant. */
  | 'unstamped_row'
  /** An upsert could reach another tenant's row. */
  | 'unguarded_upsert'
  /** An update sets the tenant column to something else. */
  | 'tenant_assignment';

/** A tenant-scoped table reference the tenant condition does not hold. */
export interface UnscopedReference {
  readonly table: string;
  readonly qualifier: string;
  readonly position: ReferencePosition;
  readonly depth: number;
  readonly gap: CoverageGap;
}

function terms(predicate: Predicate): readonly Predicate[] {
  return predicate.op === 'and' ? predicate.items.flatMap(terms) : [predicate];
}

function holdsFalse(scope: Predicate | undefined): boolean {
  return scope !== undefined && terms(scope).some((term) => term.op === 'false');
}

function covered(
  scope: Predicate | undefined,
  tenant: TenantTable,
  qualifier: string,
  value: SqlValue,
): boolean {
  if (scope === undefined) return false;
  return terms(scope).some(
    (term) =>
      term.op === 'false' ||
      (term.op === 'compare' &&
        term.comparison === '=' &&
        typeof term.column === 'object' &&
        term.column.table === qualifier &&
        term.column.column === tenant.column &&
        sameSqlValue(term.value, value)),
  );
}

function insertGap(
  insert: InsertStatement,
  tenant: TenantTable,
  value: SqlValue | undefined,
): CoverageGap | undefined {
  const positions = insert.columns.flatMap((column, index) =>
    column === tenant.column ? [index] : [],
  );
  if (
    value === undefined ||
    positions.length === 0 ||
    insert.rows.some((row) =>
      positions.some((index) => !sameSqlValue(row[index] as SqlValue, value)),
    )
  ) {
    return 'unstamped_row';
  }
  const conflict = insert.onConflict;
  if (conflict === undefined) return undefined;
  if (!conflict.target.includes(tenant.column)) return 'unguarded_upsert';
  if (
    conflict.action === 'update' &&
    (conflict.update.includes(tenant.column) || !(conflict.guard ?? []).includes(tenant.column))
  ) {
    return 'unguarded_upsert';
  }
  return undefined;
}

/** The current tenant's stored form in `tenant`'s column, if it can have one. */
function tenantValue(tenant: TenantTable, scope: TenantScopeState): SqlValue | undefined {
  if (scope.tenantId === undefined) return undefined;
  try {
    return tenant.encode(scope.tenantId);
  } catch {
    // An id the column cannot store covers nothing; the policy refuses it.
    return undefined;
  }
}

/**
 * Every reference of `statement` to a tenant-scoped table of `tables` that
 * the tenant condition of `scope` does not hold; empty when it is covered.
 */
export function findUnscopedReferences(
  statement: Statement,
  tables: PolicyTables,
  scope: TenantScopeState,
): readonly UnscopedReference[] {
  if (scope.unscoped) return [];
  const empty = statement.kind !== 'insert' && holdsFalse(statement.where);
  const gaps: UnscopedReference[] = [];
  forEachTableReference(statement, (reference) => {
    const tenant = tables.tenant(reference.table);
    if (tenant === undefined) return;
    const value = tenantValue(tenant, scope);
    let gap: CoverageGap | undefined;
    if (reference.statement.kind === 'insert') {
      gap = insertGap(reference.statement, tenant, value);
    } else if (
      value === undefined ? !empty : !covered(reference.scope, tenant, reference.qualifier, value)
    ) {
      gap = 'missing_condition';
    } else if (reference.statement.kind === 'update' && reference.position === 'update') {
      const moves = reference.statement.set.some(
        (assignment) =>
          assignment.column === tenant.column &&
          (!('value' in assignment) ||
            value === undefined ||
            !sameSqlValue(assignment.value, value)),
      );
      if (moves) gap = 'tenant_assignment';
    }
    if (gap !== undefined) {
      gaps.push(
        Object.freeze({
          table: reference.table,
          qualifier: reference.qualifier,
          position: reference.position,
          depth: reference.depth,
          gap,
        }),
      );
    }
  });
  return gaps;
}
