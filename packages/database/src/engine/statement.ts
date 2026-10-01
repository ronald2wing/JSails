/**
 * The statement shapes the engine renders: plain, serialisable data that
 * names tables and columns and carries values only as parameters. The data
 * layer above builds them (DAT-05 adds builders, the tenant policy rewrite
 * and codecs over these types); {@link Engine.compile} turns one into SQL for
 * a dialect. Every value is bound as a parameter, never spliced into the SQL,
 * so a statement's text depends only on its shape.
 *
 * A write that touches every row says so: `UPDATE` and `DELETE` require a
 * `where`, and `{ op: 'true' }` is the explicit "all rows".
 */

import type { SqlValue } from './contract.js';

/** A column, optionally qualified by a table name or alias of the statement. */
export type ColumnRef = string | { readonly table: string; readonly column: string };

/** A comparison operator. */
export type Comparison = '=' | '<>' | '<' | '<=' | '>' | '>=';

/** An ordering operator for row-value (keyset) comparison. */
export type RowComparison = '<' | '<=' | '>' | '>=';

/** A boolean condition. */
export type Predicate =
  /** `column <op> ?`; the value may not be `null` (use `null`). */
  | {
      readonly op: 'compare';
      readonly column: ColumnRef;
      readonly comparison: Comparison;
      readonly value: SqlValue;
    }
  /** `left <op> right`, both columns (a correlated subquery's join condition). */
  | {
      readonly op: 'compare-columns';
      readonly left: ColumnRef;
      readonly comparison: Comparison;
      readonly right: ColumnRef;
    }
  /** `column IN (?, ...)`; an empty list is false (true when negated). */
  | {
      readonly op: 'in';
      readonly column: ColumnRef;
      readonly values: readonly SqlValue[];
      readonly negate?: boolean;
    }
  /** `column IN (SELECT ...)`, or `(a, b) IN (SELECT ...)` for several columns. */
  | {
      readonly op: 'in-select';
      readonly columns: readonly ColumnRef[];
      readonly select: SelectStatement;
      readonly negate?: boolean;
    }
  /** `EXISTS (SELECT ...)`. */
  | { readonly op: 'exists'; readonly select: SelectStatement; readonly negate?: boolean }
  /** `(a, b) > (?, ?)`: the keyset page condition. */
  | {
      readonly op: 'row-compare';
      readonly columns: readonly ColumnRef[];
      readonly comparison: RowComparison;
      readonly values: readonly SqlValue[];
    }
  /** `column IS NULL`, or `IS NOT NULL` when negated. */
  | { readonly op: 'null'; readonly column: ColumnRef; readonly negate?: boolean }
  /**
   * `column LIKE ? ESCAPE '\'`: `%`, `_` and `\` in `pattern` are wildcards and
   * the escape character as written. Case sensitivity follows the column's
   * collation on the server dialects; SQLite folds ASCII case.
   */
  | {
      readonly op: 'like';
      readonly column: ColumnRef;
      readonly pattern: string;
      readonly negate?: boolean;
    }
  | { readonly op: 'and' | 'or'; readonly items: readonly Predicate[] }
  | { readonly op: 'not'; readonly item: Predicate }
  | { readonly op: 'true' | 'false' };

/** An output column of a select. */
export type SelectColumn =
  | { readonly column: ColumnRef; readonly as?: string }
  | {
      readonly aggregate: 'count' | 'sum' | 'min' | 'max' | 'avg';
      /** The aggregated column; omitted for `COUNT(*)`. */
      readonly column?: ColumnRef;
      readonly distinct?: boolean;
      readonly as: string;
    };

/** One ordering term. */
export interface OrderTerm {
  readonly column: ColumnRef;
  readonly direction?: 'asc' | 'desc';
  /** Where `NULL` sorts. Rendered as an explicit `IS NULL` term, so it is the same on every dialect. */
  readonly nulls?: 'first' | 'last';
}

/** A table in `FROM`. */
export interface TableRef {
  readonly table: string;
  readonly alias?: string;
}

/**
 * Keep at most `limit` rows per partition, in the statement's `orderBy`
 * order: the loader's "first N children of each parent" in one statement.
 */
export interface WindowLimit {
  readonly partitionBy: readonly ColumnRef[];
  readonly limit: number;
}

export interface SelectStatement {
  readonly kind: 'select';
  readonly from: TableRef;
  /** `'*'` selects every column; a window limit needs named columns. */
  readonly columns: readonly SelectColumn[] | '*';
  readonly distinct?: boolean;
  readonly where?: Predicate;
  readonly groupBy?: readonly ColumnRef[];
  readonly orderBy?: readonly OrderTerm[];
  readonly limit?: number;
  readonly offset?: number;
  /**
   * A row lock for the rest of the transaction. SQLite renders none: the
   * engine's write transactions already hold the database's write lock.
   */
  readonly lock?: {
    readonly mode: 'update' | 'share';
    readonly wait?: 'wait' | 'nowait' | 'skip-locked';
  };
  readonly windowLimit?: WindowLimit;
}

/**
 * What an insert does when a row conflicts with a unique key.
 *
 * MariaDB has no `ON CONFLICT`; the engine renders `ON DUPLICATE KEY UPDATE`,
 * and the result follows MariaDB's count: `affected` is 1 per inserted row, 2
 * per updated row and 1 per row left as it was (PostgreSQL and SQLite count 1
 * per inserted or updated row and 0 for a row left alone). `returning` with
 * `action: 'nothing'` is refused there, since MariaDB would also return the
 * existing rows.
 */
export type OnConflict =
  /** Leave the existing row. */
  | { readonly target: readonly string[]; readonly action: 'nothing' }
  /**
   * Set `update` columns to the incoming row's values. On MariaDB the target
   * is not stated in the SQL: any unique key conflict takes this path.
   */
  | {
      readonly target: readonly string[];
      readonly action: 'update';
      readonly update: readonly string[];
    };

export interface InsertStatement {
  readonly kind: 'insert';
  readonly table: string;
  /** The columns every row sets, in order. Empty inserts one row of defaults. */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlValue[])[];
  readonly onConflict?: OnConflict;
  /** Columns of each inserted row to return; works on all three dialects. */
  readonly returning?: readonly string[];
}

/** One `SET` term: a value, or an increment of the current value. */
export type Assignment =
  | { readonly column: string; readonly value: SqlValue }
  | { readonly column: string; readonly add: number | bigint };

export interface UpdateStatement {
  readonly kind: 'update';
  readonly table: string;
  readonly set: readonly Assignment[];
  readonly where: Predicate;
  /** Not available on MariaDB, which has no `UPDATE ... RETURNING`. */
  readonly returning?: readonly string[];
}

export interface DeleteStatement {
  readonly kind: 'delete';
  readonly table: string;
  readonly where: Predicate;
  readonly returning?: readonly string[];
}

/** Any statement the engine renders. */
export type Statement = SelectStatement | InsertStatement | UpdateStatement | DeleteStatement;

/** A rendered statement: SQL text with positional parameters, and their values. */
export interface CompiledStatement {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}
