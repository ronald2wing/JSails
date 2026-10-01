/**
 * Renaming a table qualifier inside a predicate, for embedding a model's
 * conditions in a relation subquery under an alias.
 *
 * A query's conditions are qualified by its model's table name. A relation
 * subquery reads its target under that name too, unless the name is already
 * taken by the enclosing query (a self relation): then the target gets a
 * fresh alias and its conditions are renamed to it. Renaming follows SQL
 * scoping: inside a nested select that reads a table under the old name
 * itself, the name means that table, so the walk does not rename there. A
 * fresh alias is one that appears nowhere in the predicate, so renaming
 * cannot capture a reference that meant something else.
 */

import type {
  ColumnRef,
  Join,
  OrderTerm,
  Predicate,
  SelectColumn,
  SelectStatement,
  TableRef,
} from '../engine/statement.js';
import { freezeStatement } from '../statement/builders.js';

function refName(ref: TableRef): string {
  return ref.alias ?? ref.table;
}

/** Every table name and alias a predicate mentions, at any depth. */
export function namesIn(predicate: Predicate, into: Set<string> = new Set()): Set<string> {
  const column = (ref: ColumnRef): void => {
    if (typeof ref !== 'string') into.add(ref.table);
  };
  const select = (statement: SelectStatement): void => {
    into.add(statement.from.table);
    if (statement.from.alias !== undefined) into.add(statement.from.alias);
    for (const join of statement.joins ?? []) {
      into.add(join.table.table);
      if (join.table.alias !== undefined) into.add(join.table.alias);
      namesIn(join.on, into);
    }
    if (statement.where !== undefined) namesIn(statement.where, into);
  };
  switch (predicate.op) {
    case 'compare':
    case 'in':
    case 'null':
    case 'like':
      column(predicate.column);
      break;
    case 'compare-columns':
      column(predicate.left);
      column(predicate.right);
      break;
    case 'row-compare':
      predicate.columns.forEach(column);
      break;
    case 'in-select':
      predicate.columns.forEach(column);
      select(predicate.select);
      break;
    case 'exists':
      select(predicate.select);
      break;
    case 'and':
    case 'or':
      for (const item of predicate.items) namesIn(item, into);
      break;
    case 'not':
      namesIn(predicate.item, into);
      break;
    case 'true':
    case 'false':
      break;
  }
  return into;
}

/** `${base}_1`, `${base}_2`, ...: the first not in `taken`. */
export function freshAlias(base: string, taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

class Renamer {
  constructor(
    private readonly from: string,
    private readonly to: string,
  ) {}

  column(ref: ColumnRef): ColumnRef {
    if (typeof ref === 'string' || ref.table !== this.from) return ref;
    return { table: this.to, column: ref.column };
  }

  predicate(predicate: Predicate): Predicate {
    switch (predicate.op) {
      case 'compare':
      case 'in':
      case 'null':
      case 'like':
        return { ...predicate, column: this.column(predicate.column) };
      case 'compare-columns':
        return {
          ...predicate,
          left: this.column(predicate.left),
          right: this.column(predicate.right),
        };
      case 'row-compare':
        return { ...predicate, columns: predicate.columns.map((ref) => this.column(ref)) };
      case 'in-select':
        return {
          ...predicate,
          columns: predicate.columns.map((ref) => this.column(ref)),
          select: this.select(predicate.select),
        };
      case 'exists':
        return { ...predicate, select: this.select(predicate.select) };
      case 'and':
      case 'or':
        return { ...predicate, items: predicate.items.map((item) => this.predicate(item)) };
      case 'not':
        return { ...predicate, item: this.predicate(predicate.item) };
      case 'true':
      case 'false':
        return predicate;
    }
  }

  select(statement: SelectStatement): SelectStatement {
    const shadows =
      refName(statement.from) === this.from ||
      (statement.joins ?? []).some((join) => refName(join.table) === this.from);
    if (shadows) return statement;
    const columns: SelectStatement['columns'] =
      statement.columns === '*'
        ? '*'
        : statement.columns.map((column): SelectColumn => {
            if ('aggregate' in column) {
              return column.column === undefined
                ? column
                : { ...column, column: this.column(column.column) };
            }
            return { ...column, column: this.column(column.column) };
          });
    return {
      ...statement,
      columns,
      ...(statement.joins === undefined
        ? {}
        : {
            joins: statement.joins.map((join): Join => ({ ...join, on: this.predicate(join.on) })),
          }),
      ...(statement.where === undefined ? {} : { where: this.predicate(statement.where) }),
      ...(statement.groupBy === undefined
        ? {}
        : { groupBy: statement.groupBy.map((ref) => this.column(ref)) }),
      ...(statement.orderBy === undefined
        ? {}
        : {
            orderBy: statement.orderBy.map((term): OrderTerm => ({
              ...term,
              column: this.column(term.column),
            })),
          }),
      ...(statement.windowLimit === undefined
        ? {}
        : {
            windowLimit: {
              ...statement.windowLimit,
              partitionBy: statement.windowLimit.partitionBy.map((ref) => this.column(ref)),
            },
          }),
    };
  }
}

/** `predicate` with references to table or alias `from` renamed to `to`, outside shadowing selects. */
export function requalify(predicate: Predicate, from: string, to: string): Predicate {
  if (from === to) return predicate;
  return freezeStatement(new Renamer(from, to).predicate(predicate));
}
