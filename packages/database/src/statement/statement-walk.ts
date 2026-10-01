/**
 * A walk over every table reference of a statement, at any depth: the main
 * table of each select (the inner select of a window limit is the same
 * select), each joined table, each `EXISTS` and `IN` subquery reached
 * through a `WHERE` or a join's `ON`, the scalar subquery of an update's
 * `SET` term, and the target of an insert, update or delete. Each reference
 * comes with the condition that scopes it (the select's `WHERE`, the join's
 * `ON`, the write's `WHERE`), which is where a row policy must hold.
 *
 * The tenant policy's rewrite has its own recursion; this walk serves the
 * checks that must not share its blind spots: the closed table list, the
 * ledger origin of an unscoped statement, and the coverage checker.
 */

import type { Predicate, SelectStatement, Statement } from '../engine/statement.js';

/** Where a table is referenced. */
export type ReferencePosition = 'from' | 'join' | 'insert' | 'update' | 'delete';

/** One table reference of a statement. */
export interface TableReference {
  readonly table: string;
  /** The name its columns are qualified by: the alias, else the table. */
  readonly qualifier: string;
  readonly position: ReferencePosition;
  /** 0 for the statement itself, one more per enclosing subquery. */
  readonly depth: number;
  /** The condition that scopes this reference; `undefined` for an insert or an unfiltered select. */
  readonly scope: Predicate | undefined;
  /** The statement this reference belongs to (a subquery's own select). */
  readonly statement: Statement;
}

type Visit = (reference: TableReference) => void;

function walkPredicate(predicate: Predicate | undefined, depth: number, visit: Visit): void {
  if (predicate === undefined) return;
  switch (predicate.op) {
    case 'exists':
    case 'in-select':
      walkSelect(predicate.select, depth + 1, visit);
      return;
    case 'and':
    case 'or':
      for (const item of predicate.items) walkPredicate(item, depth, visit);
      return;
    case 'not':
      walkPredicate(predicate.item, depth, visit);
      return;
    default:
      return;
  }
}

function walkSelect(select: SelectStatement, depth: number, visit: Visit): void {
  visit({
    table: select.from.table,
    qualifier: select.from.alias ?? select.from.table,
    position: 'from',
    depth,
    scope: select.where,
    statement: select,
  });
  for (const join of select.joins ?? []) {
    visit({
      table: join.table.table,
      qualifier: join.table.alias ?? join.table.table,
      position: 'join',
      depth,
      scope: join.on,
      statement: select,
    });
    walkPredicate(join.on, depth, visit);
  }
  walkPredicate(select.where, depth, visit);
}

/** Call `visit` for every table reference of `statement`, outermost first. */
export function forEachTableReference(statement: Statement, visit: Visit): void {
  switch (statement.kind) {
    case 'select':
      walkSelect(statement, 0, visit);
      return;
    case 'insert':
      visit({
        table: statement.table,
        qualifier: statement.table,
        position: 'insert',
        depth: 0,
        scope: undefined,
        statement,
      });
      return;
    case 'update':
    case 'delete':
      visit({
        table: statement.table,
        qualifier: statement.table,
        position: statement.kind,
        depth: 0,
        scope: statement.where,
        statement,
      });
      walkPredicate(statement.where, 0, visit);
      if (statement.kind === 'update') {
        for (const assignment of statement.set) {
          if ('select' in assignment) walkSelect(assignment.select, 1, visit);
        }
      }
      return;
  }
}

/** Every table reference of `statement`, outermost first. */
export function tableReferences(statement: Statement): readonly TableReference[] {
  const references: TableReference[] = [];
  forEachTableReference(statement, (reference) => references.push(reference));
  return references;
}
