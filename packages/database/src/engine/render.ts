/**
 * Renders a {@link Statement} to SQL for one dialect. Pure: no driver, no
 * connection, no TypeORM, so the data layer can compile and test statements
 * offline.
 *
 * The engine renders every shape itself (see the spike result in the engine's
 * module header). Identifier quoting and placeholders follow the drivers
 * exactly: `"name"` with `"` doubled on PostgreSQL and SQLite, `` `name` ``
 * with `` ` `` doubled on MariaDB, `$n` placeholders on PostgreSQL and `?`
 * elsewhere; a conformance test pins them to TypeORM's driver functions. On
 * top of quoting, identifiers must be plain names (letters, digits and `_`,
 * at most 63 characters), so no identifier can carry SQL.
 */

import type { Dialect, SqlValue } from './contract.js';
import { DatabaseError } from './database-error.js';
import type {
  Assignment,
  ColumnRef,
  CompiledStatement,
  DeleteStatement,
  InsertStatement,
  OrderTerm,
  Predicate,
  SelectColumn,
  SelectStatement,
  Statement,
  UpdateStatement,
} from './statement.js';

/** The most parameters one statement may bind, per dialect. */
export const BIND_LIMITS: Readonly<Record<Dialect, number>> = Object.freeze({
  postgres: 65535,
  mariadb: 65535,
  // SQLITE_MAX_VARIABLE_NUMBER's default since SQLite 3.32.
  sqlite: 32766,
});

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** MariaDB's `LIMIT` for "no limit", which it requires before an `OFFSET`. */
const MARIADB_NO_LIMIT = '18446744073709551615';

const WINDOW_ALIAS = 'jsails_w';
const WINDOW_ROW_NUMBER = 'jsails_rn';

function invalid(field: string): DatabaseError {
  return new DatabaseError('invalid_statement', { field });
}

/** Quote an identifier for `dialect`. */
export function quoteIdentifier(dialect: Dialect, name: string): string {
  if (!IDENTIFIER.test(name)) throw invalid('identifier');
  return dialect === 'mariadb' ? `\`${name}\`` : `"${name}"`;
}

/** Accumulates parameters in text order and renders their placeholders. */
class Renderer {
  readonly params: SqlValue[] = [];

  constructor(readonly dialect: Dialect) {}

  id(name: string): string {
    return quoteIdentifier(this.dialect, name);
  }

  bind(value: SqlValue): string {
    this.params.push(value);
    return this.dialect === 'postgres' ? `$${this.params.length}` : '?';
  }

  column(ref: ColumnRef): string {
    return typeof ref === 'string' ? this.id(ref) : `${this.id(ref.table)}.${this.id(ref.column)}`;
  }

  count(value: number, field: string): string {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(field);
    return this.bind(value);
  }

  predicate(predicate: Predicate): string {
    switch (predicate.op) {
      case 'compare':
        if (predicate.value === null) throw invalid('where.null-comparison');
        return `${this.column(predicate.column)} ${predicate.comparison} ${this.bind(predicate.value)}`;
      case 'compare-columns':
        return `${this.column(predicate.left)} ${predicate.comparison} ${this.column(predicate.right)}`;
      case 'in': {
        if (predicate.values.length === 0) return predicate.negate === true ? '1 = 1' : '1 = 0';
        const column = this.column(predicate.column);
        const list = predicate.values.map((value) => {
          if (value === null) throw invalid('where.null-in-list');
          return this.bind(value);
        });
        return `${column} ${predicate.negate === true ? 'NOT IN' : 'IN'} (${list.join(', ')})`;
      }
      case 'in-select': {
        if (predicate.columns.length === 0) throw invalid('where.in-select');
        if (this.dialect === 'mariadb' && predicate.select.limit !== undefined) {
          // MariaDB rejects LIMIT inside an IN subquery.
          throw new DatabaseError('unsupported_statement', { field: 'where.in-select.limit' });
        }
        const columns = predicate.columns.map((ref) => this.column(ref));
        const left = columns.length === 1 ? (columns[0] as string) : `(${columns.join(', ')})`;
        return `${left} ${predicate.negate === true ? 'NOT IN' : 'IN'} (${this.select(predicate.select)})`;
      }
      case 'exists':
        return `${predicate.negate === true ? 'NOT EXISTS' : 'EXISTS'} (${this.select(predicate.select)})`;
      case 'row-compare': {
        const count = predicate.columns.length;
        if (count === 0 || predicate.values.length !== count) throw invalid('where.row-compare');
        const columns = predicate.columns.map((ref) => this.column(ref));
        const values = predicate.values.map((value) => {
          if (value === null) throw invalid('where.null-comparison');
          return this.bind(value);
        });
        return `(${columns.join(', ')}) ${predicate.comparison} (${values.join(', ')})`;
      }
      case 'null':
        return `${this.column(predicate.column)} ${predicate.negate === true ? 'IS NOT NULL' : 'IS NULL'}`;
      case 'like': {
        // A hex literal on MariaDB: whether '\\' is one backslash or two
        // depends on the session's sql_mode.
        const escape = this.dialect === 'mariadb' ? `_utf8mb4 X'5C'` : `'\\'`;
        const operator = predicate.negate === true ? 'NOT LIKE' : 'LIKE';
        return `${this.column(predicate.column)} ${operator} ${this.bind(predicate.pattern)} ESCAPE ${escape}`;
      }
      case 'and':
      case 'or': {
        if (predicate.items.length === 0) return predicate.op === 'and' ? '1 = 1' : '1 = 0';
        const joiner = predicate.op === 'and' ? ' AND ' : ' OR ';
        return predicate.items.map((item) => `(${this.predicate(item)})`).join(joiner);
      }
      case 'not':
        return `NOT (${this.predicate(predicate.item)})`;
      case 'true':
        return '1 = 1';
      case 'false':
        return '1 = 0';
    }
  }

  selectColumn(column: SelectColumn): string {
    if ('aggregate' in column) {
      const fn = column.aggregate.toUpperCase();
      let argument: string;
      if (column.column === undefined) {
        if (column.aggregate !== 'count' || column.distinct === true) {
          throw invalid('columns.aggregate');
        }
        argument = '*';
      } else {
        argument = `${column.distinct === true ? 'DISTINCT ' : ''}${this.column(column.column)}`;
      }
      return `${fn}(${argument}) AS ${this.id(column.as)}`;
    }
    const rendered = this.column(column.column);
    return column.as === undefined ? rendered : `${rendered} AS ${this.id(column.as)}`;
  }

  orderTerm(term: OrderTerm): string {
    const column = this.column(term.column);
    const direction = term.direction === 'desc' ? 'DESC' : 'ASC';
    if (term.nulls === undefined) return `${column} ${direction}`;
    if (this.dialect === 'mariadb') {
      // MariaDB has no NULLS FIRST/LAST; sort on the null test first.
      return `${column} IS NULL ${term.nulls === 'first' ? 'DESC' : 'ASC'}, ${column} ${direction}`;
    }
    return `${column} ${direction} NULLS ${term.nulls === 'first' ? 'FIRST' : 'LAST'}`;
  }

  from(statement: SelectStatement): string {
    const table = this.id(statement.from.table);
    return statement.from.alias === undefined
      ? table
      : `${table} AS ${this.id(statement.from.alias)}`;
  }

  limitOffset(statement: SelectStatement): string {
    const { limit, offset } = statement;
    if (limit === undefined && offset === undefined) return '';
    let limitText: string;
    if (limit !== undefined) limitText = this.count(limit, 'limit');
    else if (this.dialect === 'sqlite') limitText = '-1';
    else if (this.dialect === 'mariadb') limitText = MARIADB_NO_LIMIT;
    else limitText = '';
    const limitClause = limitText === '' ? '' : ` LIMIT ${limitText}`;
    return offset === undefined
      ? limitClause
      : `${limitClause} OFFSET ${this.count(offset, 'offset')}`;
  }

  lock(statement: SelectStatement): string {
    if (statement.lock === undefined || this.dialect === 'sqlite') return '';
    const { mode, wait = 'wait' } = statement.lock;
    let clause: string;
    if (mode === 'update') clause = 'FOR UPDATE';
    else clause = this.dialect === 'mariadb' ? 'LOCK IN SHARE MODE' : 'FOR SHARE';
    if (wait === 'nowait') clause += ' NOWAIT';
    else if (wait === 'skip-locked') clause += ' SKIP LOCKED';
    return ` ${clause}`;
  }

  select(statement: SelectStatement): string {
    if (statement.windowLimit !== undefined) return this.windowSelect(statement);
    if (statement.columns !== '*' && statement.columns.length === 0) throw invalid('columns');
    const columns =
      statement.columns === '*'
        ? '*'
        : statement.columns.map((column) => this.selectColumn(column)).join(', ');
    let sql = `SELECT ${statement.distinct === true ? 'DISTINCT ' : ''}${columns} FROM ${this.from(statement)}`;
    if (statement.where !== undefined) sql += ` WHERE ${this.predicate(statement.where)}`;
    if (statement.groupBy !== undefined && statement.groupBy.length > 0) {
      sql += ` GROUP BY ${statement.groupBy.map((ref) => this.column(ref)).join(', ')}`;
    }
    if (statement.orderBy !== undefined && statement.orderBy.length > 0) {
      sql += ` ORDER BY ${statement.orderBy.map((term) => this.orderTerm(term)).join(', ')}`;
    }
    return sql + this.limitOffset(statement) + this.lock(statement);
  }

  /**
   * `SELECT cols FROM (SELECT cols, partition keys, ROW_NUMBER() OVER (...))
   * WHERE row number <= ? ORDER BY partition keys, row number`.
   */
  windowSelect(statement: SelectStatement): string {
    const window = statement.windowLimit;
    if (window === undefined) throw invalid('windowLimit');
    if (
      statement.columns === '*' ||
      statement.columns.length === 0 ||
      window.partitionBy.length === 0 ||
      statement.orderBy === undefined ||
      statement.orderBy.length === 0 ||
      statement.limit !== undefined ||
      statement.offset !== undefined ||
      statement.lock !== undefined ||
      statement.distinct === true ||
      (statement.groupBy !== undefined && statement.groupBy.length > 0)
    ) {
      throw invalid('windowLimit');
    }
    const outputs: string[] = [];
    const inner: string[] = [];
    for (const column of statement.columns) {
      if ('aggregate' in column) throw invalid('windowLimit.columns');
      const name =
        column.as ?? (typeof column.column === 'string' ? column.column : column.column.column);
      if (outputs.includes(name) || name.startsWith('jsails_')) {
        throw invalid('windowLimit.columns');
      }
      outputs.push(name);
      inner.push(`${this.column(column.column)} AS ${this.id(name)}`);
    }
    const partitionNames = window.partitionBy.map((_, index) => `jsails_p${index}`);
    window.partitionBy.forEach((ref, index) => {
      inner.push(`${this.column(ref)} AS ${this.id(partitionNames[index] as string)}`);
    });
    const partition = window.partitionBy.map((ref) => this.column(ref)).join(', ');
    const order = statement.orderBy.map((term) => this.orderTerm(term)).join(', ');
    inner.push(
      `ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${order}) AS ${this.id(WINDOW_ROW_NUMBER)}`,
    );
    let innerSql = `SELECT ${inner.join(', ')} FROM ${this.from(statement)}`;
    if (statement.where !== undefined) innerSql += ` WHERE ${this.predicate(statement.where)}`;
    const w = this.id(WINDOW_ALIAS);
    const rn = `${w}.${this.id(WINDOW_ROW_NUMBER)}`;
    const projected = outputs.map((name) => `${w}.${this.id(name)}`).join(', ');
    const limit = this.count(window.limit, 'windowLimit.limit');
    const sortKeys = [...partitionNames.map((name) => `${w}.${this.id(name)}`), rn].join(', ');
    return `SELECT ${projected} FROM (${innerSql}) AS ${w} WHERE ${rn} <= ${limit} ORDER BY ${sortKeys}`;
  }

  returning(columns: readonly string[] | undefined, field: string): string {
    if (columns === undefined) return '';
    if (columns.length === 0) throw invalid(field);
    return ` RETURNING ${columns.map((column) => this.id(column)).join(', ')}`;
  }

  insert(statement: InsertStatement): string {
    const table = this.id(statement.table);
    const width = statement.columns.length;
    if (statement.rows.length === 0) throw invalid('rows');
    let sql: string;
    if (width === 0) {
      if (statement.rows.length !== 1 || (statement.rows[0] as readonly SqlValue[]).length !== 0) {
        throw invalid('rows');
      }
      sql =
        this.dialect === 'mariadb'
          ? `INSERT INTO ${table} () VALUES ()`
          : `INSERT INTO ${table} DEFAULT VALUES`;
    } else {
      const columns = statement.columns.map((column) => this.id(column)).join(', ');
      const rows = statement.rows.map((row) => {
        if (row.length !== width) throw invalid('rows');
        return `(${row.map((value) => this.bind(value)).join(', ')})`;
      });
      sql = `INSERT INTO ${table} (${columns}) VALUES ${rows.join(', ')}`;
    }
    if (statement.onConflict !== undefined) sql += this.onConflict(statement);
    return sql + this.returning(statement.returning, 'returning');
  }

  onConflict(statement: InsertStatement): string {
    const conflict = statement.onConflict;
    if (conflict === undefined) return '';
    if (conflict.target.length === 0) throw invalid('onConflict.target');
    const target = conflict.target.map((column) => this.id(column));
    if (conflict.action === 'update' && conflict.update.length === 0) {
      throw invalid('onConflict.update');
    }
    if (this.dialect === 'mariadb') {
      if (conflict.action === 'nothing' && statement.returning !== undefined) {
        // The self-assignment below would return the existing row as well,
        // where PostgreSQL and SQLite return only the rows inserted.
        throw new DatabaseError('unsupported_statement', { field: 'onConflict.returning' });
      }
      if (conflict.action === 'nothing') {
        // A self-assignment, not INSERT IGNORE: IGNORE also turns other
        // errors (bad foreign keys, truncation) into warnings.
        const first = target[0] as string;
        return ` ON DUPLICATE KEY UPDATE ${first} = ${first}`;
      }
      const set = conflict.update.map((column) => {
        const id = this.id(column);
        return `${id} = VALUES(${id})`;
      });
      return ` ON DUPLICATE KEY UPDATE ${set.join(', ')}`;
    }
    if (conflict.action === 'nothing') return ` ON CONFLICT (${target.join(', ')}) DO NOTHING`;
    const set = conflict.update.map((column) => {
      const id = this.id(column);
      return `${id} = EXCLUDED.${id}`;
    });
    return ` ON CONFLICT (${target.join(', ')}) DO UPDATE SET ${set.join(', ')}`;
  }

  assignment(assignment: Assignment): string {
    const id = this.id(assignment.column);
    if ('add' in assignment) {
      if (typeof assignment.add === 'number' && !Number.isFinite(assignment.add)) {
        throw invalid('set.add');
      }
      return `${id} = ${id} + ${this.bind(assignment.add)}`;
    }
    return `${id} = ${this.bind(assignment.value)}`;
  }

  update(statement: UpdateStatement): string {
    if (statement.set.length === 0) throw invalid('set');
    if (statement.returning !== undefined && this.dialect === 'mariadb') {
      throw new DatabaseError('unsupported_statement', { field: 'returning' });
    }
    const set = statement.set.map((assignment) => this.assignment(assignment)).join(', ');
    const where = this.predicate(statement.where);
    return (
      `UPDATE ${this.id(statement.table)} SET ${set} WHERE ${where}` +
      this.returning(statement.returning, 'returning')
    );
  }

  delete(statement: DeleteStatement): string {
    const where = this.predicate(statement.where);
    return (
      `DELETE FROM ${this.id(statement.table)} WHERE ${where}` +
      this.returning(statement.returning, 'returning')
    );
  }
}

/**
 * Render `statement` for `dialect`.
 *
 * @throws {DatabaseError} `invalid_statement` for a malformed statement,
 *   `unsupported_statement` for a shape the dialect cannot run, and
 *   `too_many_parameters` past the dialect's bind limit.
 */
export function compileStatement(statement: Statement, dialect: Dialect): CompiledStatement {
  const renderer = new Renderer(dialect);
  let sql: string;
  switch (statement.kind) {
    case 'select':
      sql = renderer.select(statement);
      break;
    case 'insert':
      sql = renderer.insert(statement);
      break;
    case 'update':
      sql = renderer.update(statement);
      break;
    case 'delete':
      sql = renderer.delete(statement);
      break;
    default:
      throw invalid('kind');
  }
  if (renderer.params.length > BIND_LIMITS[dialect]) {
    throw new DatabaseError('too_many_parameters');
  }
  return Object.freeze({ sql, params: Object.freeze(renderer.params) });
}
