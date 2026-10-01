/**
 * The one error class of the data engine. Its message is fixed per code and
 * never carries SQL, parameter values, row data or credentials; `context`
 * holds only schema identifiers and driver codes, which are neither.
 */

import { JsailsError } from 'jsails/support';

/** Machine-readable reason for a {@link DatabaseError}. */
export type DatabaseErrorCode =
  // Constraint violations, classified from the driver's own error code.
  | 'unique_violation'
  | 'foreign_key_violation'
  | 'not_null_violation'
  | 'check_violation'
  // Concurrency: re-running the whole transaction may succeed.
  | 'deadlock'
  | 'serialization_failure'
  | 'lock_timeout'
  | 'busy'
  // Statement and transaction state.
  | 'statement_timeout'
  | 'read_only'
  | 'transaction_aborted'
  | 'query_failed'
  // Connections.
  | 'connection_failed'
  | 'acquire_timeout'
  | 'closed'
  | 'released'
  // Misuse of the engine contract.
  | 'invalid_statement'
  | 'invalid_parameter'
  | 'too_many_parameters'
  | 'unsupported_statement'
  | 'invalid_state'
  // Configuration and environment.
  | 'invalid_config'
  | 'missing_dependency'
  | 'unsupported_server'
  | 'unsupported_version';

const MESSAGES: Readonly<Record<DatabaseErrorCode, string>> = Object.freeze({
  unique_violation: 'a unique constraint was violated',
  foreign_key_violation: 'a foreign key constraint was violated',
  not_null_violation: 'a NOT NULL constraint was violated',
  check_violation: 'a check constraint was violated',
  deadlock: 'the transaction was chosen as a deadlock victim',
  serialization_failure: 'the transaction could not be serialized with a concurrent one',
  lock_timeout: 'a row or table lock was not granted in time',
  busy: 'the database file stayed locked by another connection past the busy timeout',
  statement_timeout: 'the statement ran past the statement timeout and was cancelled',
  read_only: 'the statement tried to write in a read-only transaction or database',
  transaction_aborted: 'the transaction was aborted by an earlier failed statement',
  query_failed: 'the database rejected the statement',
  connection_failed: 'the database connection failed',
  acquire_timeout: 'no database connection became free within the acquire timeout',
  closed: 'the database engine is closed',
  released: 'the connection was already released',
  invalid_statement: 'the statement is not valid for the engine',
  invalid_parameter: 'a statement parameter has a type the engine does not bind',
  too_many_parameters: 'the statement binds more parameters than this database allows',
  unsupported_statement: 'this database cannot run the statement shape',
  invalid_state: 'the connection is not in a state that allows this operation',
  invalid_config: 'the database configuration is invalid',
  missing_dependency: 'the database driver package is not installed',
  unsupported_server: 'the database server is not a supported product',
  unsupported_version: 'the database server is older than the supported floor',
});

const TRANSIENT: ReadonlySet<DatabaseErrorCode> = new Set([
  'deadlock',
  'serialization_failure',
  'lock_timeout',
  'busy',
]);

/** Optional detail of a {@link DatabaseError}; never a value or a secret. */
export interface DatabaseErrorDetail {
  /** The driver's own code: a SQLSTATE, a MariaDB errno, or a SQLite extended code. */
  readonly driverCode?: string;
  /** The violated constraint or index, when the driver names it. */
  readonly constraint?: string;
  /** The npm package that is missing, for `missing_dependency`. */
  readonly dependency?: string;
  /** Which part of the input was wrong: an option name, a parameter position. */
  readonly field?: string;
  /** A one-line fix, static text. */
  readonly suggestion?: string;
}

/** A value-free failure of the data engine. */
export class DatabaseError extends JsailsError {
  readonly code: DatabaseErrorCode;
  /**
   * Whether re-running the whole transaction may succeed: a deadlock, a
   * serialization failure, a lock timeout, or a busy SQLite file.
   */
  readonly transient: boolean;
  readonly driverCode: string | undefined;
  readonly constraint: string | undefined;

  constructor(code: DatabaseErrorCode, detail: DatabaseErrorDetail = {}) {
    const context: Record<string, string> = {};
    if (detail.driverCode !== undefined) context.driverCode = detail.driverCode;
    if (detail.constraint !== undefined) context.constraint = detail.constraint;
    if (detail.dependency !== undefined) context.dependency = detail.dependency;
    if (detail.field !== undefined) context.field = detail.field;
    const where = detail.field === undefined ? '' : ` (${detail.field})`;
    super(
      `${MESSAGES[code]}${where}`,
      detail.suggestion === undefined ? { context } : { context, suggestion: detail.suggestion },
    );
    this.code = code;
    this.transient = TRANSIENT.has(code);
    this.driverCode = detail.driverCode;
    this.constraint = detail.constraint;
  }
}

/** Whether `error` is a {@link DatabaseError}, optionally with one of `codes`. */
export function isDatabaseError(
  error: unknown,
  ...codes: readonly DatabaseErrorCode[]
): error is DatabaseError {
  return error instanceof DatabaseError && (codes.length === 0 || codes.includes(error.code));
}
