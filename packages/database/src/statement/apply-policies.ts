/**
 * The tenant policy as a pure rewrite of the statement IR:
 * `applyPolicies(statement, context)` returns a new frozen statement and
 * never touches a database or the ambient context (the guarded compiler
 * reads the scope and passes it in).
 *
 * For every reference to a tenant-scoped table (the main table of a select,
 * each joined table, each `EXISTS`/`IN` subquery at any depth, the inner
 * select of a window limit, which is the select's own `WHERE`, the scalar
 * subquery of an update's `SET` term, and the target of a write) the tenant
 * condition `qualifier.tenant = ?` is ANDed first into the condition that
 * scopes it: the `WHERE`, or the join's `ON`, where it filters an inner join
 * and keeps a left join's meaning.
 *
 * - No current tenant: a read that references a tenant-scoped table anywhere
 *   gets `1 = 0` as its outermost `WHERE`, so it returns nothing at all; a
 *   write that does throws `tenant_scope.no_tenant`. Emptying only the
 *   tenant-scoped reference is not enough: under `NOT EXISTS`, `NOT IN` or
 *   `NOT` an emptied subquery holds for every outer row, and a left join
 *   keeps every row of its left side, so the statement would still reach
 *   every outer row, as though no tenant had a matching row.
 * - Insert: the tenant column is stamped when missing; a row naming another
 *   tenant throws `tenant_mismatch`.
 * - Update: a SET of the tenant column to another tenant, by increment or
 *   by subquery, throws `tenant_assignment`.
 * - Upsert: the conflict target must include the tenant column
 *   (`upsert_without_tenant`), the update may not set it
 *   (`tenant_assignment`), and the tenant column becomes a guard, so a
 *   conflict on any other unique key (MariaDB takes the update path for all
 *   of them) never rewrites another tenant's row.
 * - Inside `withoutTenantScope` the statement is returned unchanged.
 *
 * Every table must be one the catalog declares (`statement.unknown_table`),
 * scoped or not, so a tenant-scoped table missing from the model list cannot
 * pass as a global one.
 */

import { reportedName } from '../codec/codec-errors.js';
import type { SqlValue } from '../engine/contract.js';
import type {
  Assignment,
  InsertStatement,
  Join,
  Predicate,
  SelectStatement,
  Statement,
  UpdateStatement,
} from '../engine/statement.js';
import { and, col, eq, FALSE, freezeStatement } from './builders.js';
import { sameSqlValue } from './same-sql-value.js';
import type { PolicyTables, TenantTable } from './statement-catalog.js';
import { StatementErrors, TenantScopeErrors } from './statement-errors.js';
import { forEachTableReference } from './statement-walk.js';
import type { TenantScopeState } from './tenant-scope.js';

/** What a policy rewrite reads: the catalog's tables and the tenant scope. */
export interface PolicyContext {
  readonly tables: PolicyTables;
  readonly scope: TenantScopeState;
}

class TenantRewrite {
  readonly #encoded = new Map<string, SqlValue>();

  constructor(
    private readonly tables: PolicyTables,
    private readonly scope: TenantScopeState,
  ) {}

  /** The current tenant's stored form in `tenant`'s column; throws on a write without one. */
  encoded(tenant: TenantTable): SqlValue {
    const tenantId = this.scope.tenantId;
    if (tenantId === undefined) {
      throw new TenantScopeErrors.Error('no_tenant', { table: tenant.table });
    }
    let value = this.#encoded.get(tenant.table);
    if (value === undefined && !this.#encoded.has(tenant.table)) {
      value = tenant.encode(tenantId);
      this.#encoded.set(tenant.table, value);
    }
    return value as SqlValue;
  }

  /** The tenant condition of a reference qualified by `qualifier`. */
  condition(tenant: TenantTable, qualifier: string): Predicate {
    return eq(col(qualifier, tenant.column), this.encoded(tenant));
  }

  scoped(table: string, qualifier: string, scope: Predicate | undefined) {
    const tenant = this.tables.tenant(table);
    const rewritten = scope === undefined ? undefined : this.predicate(scope);
    if (tenant === undefined) return rewritten;
    const condition = this.condition(tenant, qualifier);
    return rewritten === undefined ? condition : and(condition, rewritten);
  }

  predicate(predicate: Predicate): Predicate {
    switch (predicate.op) {
      case 'exists':
      case 'in-select':
        return freezeStatement({ ...predicate, select: this.select(predicate.select) });
      case 'and':
      case 'or':
        return freezeStatement({
          ...predicate,
          items: predicate.items.map((item) => this.predicate(item)),
        });
      case 'not':
        return freezeStatement({ ...predicate, item: this.predicate(predicate.item) });
      default:
        return predicate;
    }
  }

  join(join: Join): Join {
    const qualifier = join.table.alias ?? join.table.table;
    const on = this.scoped(join.table.table, qualifier, join.on) as Predicate;
    return freezeStatement({ ...join, on });
  }

  select(select: SelectStatement): SelectStatement {
    const qualifier = select.from.alias ?? select.from.table;
    const where = this.scoped(select.from.table, qualifier, select.where);
    const joins = select.joins?.map((join) => this.join(join));
    // `where` is unset only when the select had none and needs none; `joins`
    // only when it had none.
    return freezeStatement({
      ...select,
      ...(joins === undefined ? {} : { joins }),
      ...(where === undefined ? {} : { where }),
    });
  }

  assignments(update: UpdateStatement): readonly Assignment[] {
    const tenant = this.tables.tenant(update.table);
    for (const assignment of update.set) {
      if (tenant === undefined || assignment.column !== tenant.column) continue;
      if (!('value' in assignment) || !sameSqlValue(assignment.value, this.encoded(tenant))) {
        throw new TenantScopeErrors.Error('tenant_assignment', { table: update.table });
      }
    }
    if (!update.set.some((assignment) => 'select' in assignment)) return update.set;
    return update.set.map((assignment) =>
      'select' in assignment
        ? freezeStatement({ ...assignment, select: this.select(assignment.select) })
        : assignment,
    );
  }

  insert(insert: InsertStatement): InsertStatement {
    const tenant = this.tables.tenant(insert.table);
    if (tenant === undefined) return insert;
    const value = this.encoded(tenant);
    // Every position naming the tenant column, though the renderer refuses
    // a column named twice: the rewrite does not rely on that.
    const positions = insert.columns.flatMap((column, index) =>
      column === tenant.column ? [index] : [],
    );
    let { columns, rows } = insert;
    if (positions.length === 0) {
      columns = [...columns, tenant.column];
      rows = rows.map((row) => [...row, value]);
    } else {
      for (const row of rows) {
        if (positions.some((index) => !sameSqlValue(row[index] as SqlValue, value))) {
          throw new TenantScopeErrors.Error('tenant_mismatch', { table: insert.table });
        }
      }
    }
    let onConflict = insert.onConflict;
    if (onConflict !== undefined) {
      if (!onConflict.target.includes(tenant.column)) {
        throw new TenantScopeErrors.Error('upsert_without_tenant', { table: insert.table });
      }
      if (onConflict.action === 'update') {
        if (onConflict.update.includes(tenant.column)) {
          throw new TenantScopeErrors.Error('tenant_assignment', { table: insert.table });
        }
        const guard = onConflict.guard ?? [];
        onConflict = {
          ...onConflict,
          guard: guard.includes(tenant.column) ? guard : [...guard, tenant.column],
        };
      }
    }
    return freezeStatement({
      ...insert,
      columns,
      rows,
      ...(onConflict === undefined ? {} : { onConflict }),
    });
  }

  statement(statement: Statement): Statement {
    switch (statement.kind) {
      case 'select':
        return this.select(statement);
      case 'insert':
        return this.insert(statement);
      case 'update': {
        const set = this.assignments(statement);
        const where = this.scoped(statement.table, statement.table, statement.where);
        return freezeStatement({ ...statement, set, where: where as Predicate });
      }
      case 'delete': {
        const where = this.scoped(statement.table, statement.table, statement.where);
        return freezeStatement({ ...statement, where: where as Predicate });
      }
    }
  }
}

/**
 * A read with no current tenant that references a tenant-scoped table: the
 * same select with `1 = 0` as its whole `WHERE`, so it returns no row, and
 * an aggregate reads an empty set. Its joins and columns stay as they are:
 * with no row passing the `WHERE`, nothing they hold can reach a result.
 */
function emptied(select: SelectStatement): SelectStatement {
  return freezeStatement({ ...select, where: FALSE });
}

/**
 * Refuse a statement that names a table the catalog does not declare.
 *
 * @throws `statement.unknown_table`.
 */
export function assertKnownTables(statement: Statement, tables: PolicyTables): void {
  forEachTableReference(statement, (reference) => {
    if (!tables.has(reference.table)) {
      throw new StatementErrors.Error('unknown_table', { table: reportedName(reference.table) });
    }
  });
}

/** Whether `statement` references a tenant-scoped table anywhere. */
export function touchesTenantTable(statement: Statement, tables: PolicyTables): boolean {
  let touches = false;
  forEachTableReference(statement, (reference) => {
    if (tables.tenant(reference.table) !== undefined) touches = true;
  });
  return touches;
}

/**
 * The tenant policy applied to `statement` under `context.scope`.
 *
 * @throws `statement.unknown_table`, and the `tenant_scope.*` codes listed in
 *   the module documentation.
 */
export function applyPolicies(statement: Statement, context: PolicyContext): Statement {
  assertKnownTables(statement, context.tables);
  if (context.scope.unscoped) return statement;
  if (
    context.scope.tenantId === undefined &&
    statement.kind === 'select' &&
    touchesTenantTable(statement, context.tables)
  ) {
    return emptied(statement);
  }
  return new TenantRewrite(context.tables, context.scope).statement(statement);
}
