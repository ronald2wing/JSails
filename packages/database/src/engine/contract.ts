/**
 * The Engine contract: plain SQL and plain values in, plain rows out. Nothing
 * here names TypeORM or a driver; the engines behind it are the only code in
 * the data layer that does.
 *
 * Values are what the drivers carry after the engine's normalisation, the
 * same on every dialect: integers are `number`, or `bigint` outside the safe
 * range; `DECIMAL`/`NUMERIC`, date, time, timestamp and JSON columns come
 * back as the server's text; binary is a `Uint8Array` (a `Buffer` on the
 * server drivers); booleans are `boolean` on PostgreSQL and `0`/`1` elsewhere.
 * Turning those into application values is the codec layer's job (DAT-05),
 * not the engine's.
 */

import type { CompiledStatement, Statement } from './statement.js';

/** A supported database dialect. MySQL other than MariaDB is not supported. */
export type Dialect = 'postgres' | 'mariadb' | 'sqlite';

/** A value bound to a statement parameter or read from a result column. */
export type SqlValue = null | boolean | number | bigint | string | Uint8Array;

/** One result row, keyed by column name. */
export type Row = Readonly<Record<string, SqlValue>>;

/** What a statement returned. */
export interface QueryResult {
  /** The rows of a read, or of a write with `RETURNING`; empty otherwise. */
  readonly rows: readonly Row[];
  /**
   * Rows the statement inserted, updated or deleted; `0` for a read. An
   * `UPDATE` counts the rows it matched on every dialect, whether or not a
   * value changed. A write with `RETURNING` counts the rows it returned. An
   * upsert on MariaDB counts as MariaDB does (see `OnConflict`).
   */
  readonly affected: number;
  /**
   * The generated key of the last inserted row, where the driver reports one
   * (MariaDB and SQLite, for an `INSERT` that inserted). Use `RETURNING` for
   * portable code: it works on all three dialects.
   */
  readonly insertId?: number | bigint;
}

/** Per-statement options. */
export interface QueryOptions {
  /**
   * Who issued the statement, recorded in the query ledger (`'app'` when
   * unset). The data layer marks its own statements, `unguarded` SQL and
   * tenant-scope opt-outs with their own origins.
   */
  readonly origin?: string;
}

/**
 * A database connection held by one caller until {@link Conn.release}. On the
 * server dialects it is one pooled connection; on SQLite an autocommit lease
 * routes each statement to the shared reader or, under the writer lock, to
 * the writer.
 */
export interface Conn {
  readonly dialect: Dialect;
  /** Run one statement. Every call is recorded in the active query ledgers. */
  query(sql: string, params?: readonly SqlValue[], options?: QueryOptions): Promise<QueryResult>;
  /**
   * Give the connection back. A transaction still open is rolled back first,
   * and a connection whose state is unknown is discarded, not pooled.
   * Releasing twice is a no-op.
   */
  release(): Promise<void>;
}

/** A transaction isolation level, applied at `BEGIN`. */
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** Options for {@link Engine.begin}. */
export interface TransactionOptions {
  /**
   * A read-only transaction. On SQLite it runs on a read handle of its own
   * and never waits for the writer.
   */
  readonly readOnly?: boolean;
  /**
   * The isolation level; the server's default when unset. SQLite
   * transactions are always serializable, which satisfies every level.
   */
  readonly isolation?: IsolationLevel;
}

/** A savepoint inside a {@link TransactionConn}, ended exactly once. */
export interface Savepoint {
  /** Undo everything since the savepoint, and end it. */
  rollback(): Promise<void>;
  /** Keep everything since the savepoint, and end it. */
  release(): Promise<void>;
}

/**
 * A connection inside an open transaction. The engine issues `BEGIN`,
 * `SAVEPOINT`, `ROLLBACK TO` and `COMMIT` itself; a statement that does so
 * through {@link Conn.query} is outside the contract, and so is DDL on
 * MariaDB, which commits implicitly.
 *
 * When a failed statement ended the whole transaction on the server (a
 * deadlock victim on PostgreSQL or MariaDB, `RAISE(ROLLBACK)` on SQLite),
 * every later statement and savepoint call fails with `transaction_aborted`
 * and nothing runs in autocommit in its place; `commit()` fails the same way
 * and `rollback()` succeeds. A statement failure that leaves the transaction
 * open (a constraint violation on MariaDB or SQLite) does not; PostgreSQL
 * refuses further statements after any failure until a savepoint rollback.
 */
export interface TransactionConn extends Conn {
  /** Open a savepoint; savepoints nest and end innermost first. */
  savepoint(): Promise<Savepoint>;
  /**
   * Commit and release. A transaction the server already aborted is rolled
   * back and reported as `transaction_aborted`, never as committed.
   */
  commit(): Promise<void>;
  /** Roll back and release. */
  rollback(): Promise<void>;
}

/** The data engine for one database. */
export interface Engine {
  readonly dialect: Dialect;
  /** The server's version string, read when the engine opened. */
  readonly serverVersion: string;
  /** The most parameters one statement may bind on this dialect. */
  readonly bindLimit: number;
  /** An autocommit connection. */
  lease(): Promise<Conn>;
  /** A connection inside a new transaction. */
  begin(options?: TransactionOptions): Promise<TransactionConn>;
  /** Render a statement for this dialect. Pure: it never touches the database. */
  compile(statement: Statement): CompiledStatement;
  /**
   * Close every connection. Waiting callers are rejected with `closed`,
   * connections still leased are discarded (an open transaction rolls back),
   * and every later call fails with `closed`.
   */
  close(): Promise<void>;
}
