/**
 * Classifies a real driver error into a value-free {@link DatabaseError}.
 *
 * Each driver reports failures in its own vocabulary: PostgreSQL a SQLSTATE in
 * `code`, MariaDB an `errno` (mysql2 adds a symbolic `code` for most of them),
 * node:sqlite an extended result code in `errcode`, and a socket failure a
 * Node `code` such as `ECONNREFUSED`. The tables below map each to one engine
 * code. The driver's message is never copied: MariaDB's duplicate-key text
 * carries the duplicate value, so only the constraint name is extracted from
 * it. An unmapped statement error becomes `query_failed` with the driver code
 * kept, so it stays diagnosable without echoing input.
 */

import type { Dialect } from './contract.js';
import { DatabaseError, type DatabaseErrorCode } from './database-error.js';

/** Where the error happened: opening a connection, or running a statement. */
export type DriverErrorPhase = 'connect' | 'query';

const POSTGRES_CODES: Readonly<Record<string, DatabaseErrorCode>> = {
  '23505': 'unique_violation',
  '23503': 'foreign_key_violation',
  '23502': 'not_null_violation',
  '23514': 'check_violation',
  '40P01': 'deadlock',
  '40001': 'serialization_failure',
  '55P03': 'lock_timeout',
  '57014': 'statement_timeout',
  '25006': 'read_only',
  '25P02': 'transaction_aborted',
  '28000': 'connection_failed',
  '28P01': 'connection_failed',
  '3D000': 'connection_failed',
  '57P01': 'connection_failed',
  '57P02': 'connection_failed',
  '57P03': 'connection_failed',
  '53300': 'connection_failed',
};

const MARIADB_ERRNOS: Readonly<Record<number, DatabaseErrorCode>> = {
  1062: 'unique_violation', // ER_DUP_ENTRY
  1586: 'unique_violation', // ER_DUP_ENTRY_WITH_KEY_NAME
  1451: 'foreign_key_violation', // ER_ROW_IS_REFERENCED_2
  1452: 'foreign_key_violation', // ER_NO_REFERENCED_ROW_2
  1216: 'foreign_key_violation', // ER_NO_REFERENCED_ROW
  1217: 'foreign_key_violation', // ER_ROW_IS_REFERENCED
  1048: 'not_null_violation', // ER_BAD_NULL_ERROR
  1364: 'not_null_violation', // ER_NO_DEFAULT_FOR_FIELD
  4025: 'check_violation', // ER_CONSTRAINT_FAILED
  1213: 'deadlock', // ER_LOCK_DEADLOCK
  1020: 'serialization_failure', // ER_CHECKREAD, under innodb_snapshot_isolation
  1205: 'lock_timeout', // ER_LOCK_WAIT_TIMEOUT
  3572: 'lock_timeout', // ER_LOCK_NOWAIT
  1969: 'statement_timeout', // ER_STATEMENT_TIMEOUT
  1792: 'read_only', // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
  1290: 'read_only', // ER_OPTION_PREVENTS_STATEMENT (--read-only)
  1045: 'connection_failed', // ER_ACCESS_DENIED_ERROR
  1044: 'connection_failed', // ER_DBACCESS_DENIED_ERROR
  1049: 'connection_failed', // ER_BAD_DB_ERROR
  1040: 'connection_failed', // ER_CON_COUNT_ERROR
  1927: 'connection_failed', // ER_CONNECTION_KILLED
  2006: 'connection_failed', // CR_SERVER_GONE_ERROR
  2013: 'connection_failed', // CR_SERVER_LOST
};

/** SQLite extended result codes; a primary code is the low byte. */
const SQLITE_EXTENDED: Readonly<Record<number, DatabaseErrorCode>> = {
  2067: 'unique_violation', // SQLITE_CONSTRAINT_UNIQUE
  1555: 'unique_violation', // SQLITE_CONSTRAINT_PRIMARYKEY
  787: 'foreign_key_violation', // SQLITE_CONSTRAINT_FOREIGNKEY
  1299: 'not_null_violation', // SQLITE_CONSTRAINT_NOTNULL
  275: 'check_violation', // SQLITE_CONSTRAINT_CHECK
  517: 'serialization_failure', // SQLITE_BUSY_SNAPSHOT
};

const SQLITE_PRIMARY: Readonly<Record<number, DatabaseErrorCode>> = {
  5: 'busy', // SQLITE_BUSY, and SQLITE_BUSY_RECOVERY / _TIMEOUT
  6: 'busy', // SQLITE_LOCKED
  8: 'read_only', // SQLITE_READONLY
  14: 'connection_failed', // SQLITE_CANTOPEN
};

/** Socket and client-side codes shared by both server drivers. */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_ACCESS_DENIED_ERROR',
]);

/** The SQLite primary codes that mean "retry later", not "rejected". */
const SQLITE_BUSY_PRIMARY: ReadonlySet<number> = new Set([5, 6]);

interface ErrorFields {
  readonly code?: unknown;
  readonly errno?: unknown;
  readonly errcode?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
  readonly driverError?: unknown;
}

function fieldsOf(error: unknown): ErrorFields {
  if (typeof error !== 'object' || error === null) return {};
  const fields = error as ErrorFields;
  // A TypeORM QueryFailedError wraps the driver's error; classify the inner one.
  if (typeof fields.driverError === 'object' && fields.driverError !== null) {
    return fields.driverError;
  }
  return fields;
}

function messageOf(fields: ErrorFields): string {
  return typeof fields.message === 'string' ? fields.message : '';
}

/** A constraint name from MariaDB's message text, without the value it also carries. */
function mariadbConstraint(errno: number, message: string): string | undefined {
  if (errno === 1062 || errno === 1586) return /for key '([^']+)'$/.exec(message)?.[1];
  return /CONSTRAINT `([^`]+)`/.exec(message)?.[1];
}

/** The columns SQLite names in a constraint message (`UNIQUE constraint failed: t.a, t.b`). */
function sqliteConstraint(message: string): string | undefined {
  const match = /constraint failed: ([\w.,\s"]+)$/.exec(message);
  return match?.[1]?.replace(/\s+/g, '');
}

function classifyPostgres(fields: ErrorFields, phase: DriverErrorPhase): DatabaseError {
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  if (code !== undefined && CONNECTION_CODES.has(code)) {
    return new DatabaseError('connection_failed', { driverCode: code });
  }
  if (code !== undefined && /^[0-9A-Z]{5}$/.test(code)) {
    const mapped =
      POSTGRES_CODES[code] ?? (code.startsWith('08') ? 'connection_failed' : undefined);
    const constraint = typeof fields.constraint === 'string' ? fields.constraint : undefined;
    return new DatabaseError(mapped ?? 'query_failed', {
      driverCode: code,
      ...(constraint === undefined ? {} : { constraint }),
    });
  }
  return new DatabaseError(phase === 'connect' ? 'connection_failed' : 'query_failed');
}

function classifyMariadb(fields: ErrorFields, phase: DriverErrorPhase): DatabaseError {
  const symbol = typeof fields.code === 'string' ? fields.code : undefined;
  const errno = typeof fields.errno === 'number' ? fields.errno : undefined;
  if (errno !== undefined && errno > 0 && errno < 10000) {
    const mapped = MARIADB_ERRNOS[errno];
    const constraint =
      mapped === undefined ? undefined : mariadbConstraint(errno, messageOf(fields));
    return new DatabaseError(mapped ?? 'query_failed', {
      driverCode: String(errno),
      ...(constraint === undefined ? {} : { constraint }),
    });
  }
  if (symbol !== undefined && CONNECTION_CODES.has(symbol)) {
    return new DatabaseError('connection_failed', { driverCode: symbol });
  }
  return new DatabaseError(phase === 'connect' ? 'connection_failed' : 'query_failed');
}

function classifySqlite(fields: ErrorFields, phase: DriverErrorPhase): DatabaseError {
  const errcode = typeof fields.errcode === 'number' ? fields.errcode : undefined;
  if (errcode === undefined) {
    return new DatabaseError(phase === 'connect' ? 'connection_failed' : 'query_failed');
  }
  const mapped = SQLITE_EXTENDED[errcode] ?? SQLITE_PRIMARY[errcode & 0xff];
  const constraint =
    mapped !== undefined && mapped.endsWith('_violation')
      ? sqliteConstraint(messageOf(fields))
      : undefined;
  return new DatabaseError(mapped ?? 'query_failed', {
    driverCode: String(errcode),
    ...(constraint === undefined ? {} : { constraint }),
  });
}

/**
 * The {@link DatabaseError} for a driver failure. A `DatabaseError` passes
 * through unchanged.
 */
export function classifyDriverError(
  error: unknown,
  dialect: Dialect,
  phase: DriverErrorPhase = 'query',
): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const fields = fieldsOf(error);
  switch (dialect) {
    case 'postgres':
      return classifyPostgres(fields, phase);
    case 'mariadb':
      return classifyMariadb(fields, phase);
    case 'sqlite':
      return classifySqlite(fields, phase);
  }
}

/** Whether a node:sqlite error is SQLITE_BUSY or SQLITE_LOCKED, which a later retry may clear. */
export function isSqliteBusy(error: unknown): boolean {
  const { errcode } = fieldsOf(error);
  return typeof errcode === 'number' && SQLITE_BUSY_PRIMARY.has(errcode & 0xff) && errcode !== 517;
}
