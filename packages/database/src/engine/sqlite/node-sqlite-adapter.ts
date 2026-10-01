/**
 * node:sqlite's `DatabaseSync` behind the `better-sqlite3` constructor
 * TypeORM's `better-sqlite3` driver expects, injected through its `driver`
 * option: no subclassing of TypeORM and no deep import. TypeORM opens and
 * closes the handle (creating the directory and turning foreign keys on);
 * the engine runs statements through {@link NodeSqliteDatabase.execute}.
 *
 * - `prepare()` returns better-sqlite3's statement surface; node:sqlite has no
 *   `reader` flag, so it is derived from `columns().length > 0` (true for a
 *   `SELECT` and for a write with `RETURNING`).
 * - `pragma()` is implemented here; node:sqlite has none.
 * - The busy timeout is always 0: SQLite's own busy wait blocks the event
 *   loop, so the engine retries `SQLITE_BUSY` asynchronously instead.
 * - node:sqlite binds every JavaScript number as a REAL, so `n + ?` turns an
 *   exact 64-bit integer column into a rounded float and `7 / ?` stops being
 *   integer division. An integral number therefore binds as a `bigint`
 *   (SQLite INTEGER); booleans bind as 0/1.
 * - Integers read as `bigint` and come back as `number` when they are safe
 *   integers, so a 64-bit value is never rounded.
 *
 * Every call is synchronous and blocks the event loop for its duration; that
 * is the cost of node:sqlite and the reason the engine keeps one writer.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { Row, SqlValue } from '../contract.js';
import { isWriteKeyword, leadingKeyword } from '../sql-keyword.js';

/** The options TypeORM's better-sqlite3 driver passes to the constructor. */
export interface BetterSqlite3ConstructorOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly timeout?: number;
}

/** better-sqlite3's statement surface, as TypeORM's query runner reads it. */
export interface CompatStatement {
  readonly reader: boolean;
  all(...params: SqlValue[]): unknown[];
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

/** What one statement did, before the connection layer freezes it. */
export interface SqliteExecution {
  readonly rows: Row[];
  readonly affected: number;
  readonly insertId?: number | bigint;
}

interface CachedStatement {
  readonly statement: StatementSync;
  readonly reader: boolean;
  readonly keyword: string;
}

const STATEMENT_CACHE_SIZE = 200;

/** 2^63: an integral number at or past it does not fit SQLite's INTEGER. */
const INT64_LIMIT = 2 ** 63;

/** An integral number binds as INTEGER, not REAL; booleans as 0/1. */
function bindable(value: SqlValue): Exclude<SqlValue, boolean | number> | number {
  if (typeof value === 'number') {
    return Number.isInteger(value) && Math.abs(value) < INT64_LIMIT ? BigInt(value) : value;
  }
  if (typeof value === 'boolean') return value ? 1n : 0n;
  return value;
}

function narrow(value: number | bigint): number | bigint {
  return typeof value === 'bigint' &&
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value;
}

/** Read integers come back as bigint; give back numbers where that loses nothing. */
function narrowRow(row: Record<string, SqlValue>): Row {
  for (const key in row) {
    const value = row[key];
    if (typeof value === 'bigint') row[key] = narrow(value);
  }
  return row;
}

export class NodeSqliteDatabase {
  readonly #db: DatabaseSync;
  readonly #cache = new Map<string, CachedStatement>();

  constructor(file: string, options: BetterSqlite3ConstructorOptions = {}) {
    this.#db = new DatabaseSync(file, {
      readOnly: options.readonly === true,
      timeout: 0,
      enableForeignKeyConstraints: true,
    });
  }

  /** Whether the handle is open. */
  get open(): boolean {
    return this.#db.isOpen;
  }

  /** Whether a transaction is open on this handle. */
  get inTransaction(): boolean {
    return this.#db.isTransaction;
  }

  #cached(sql: string): CachedStatement {
    let cached = this.#cache.get(sql);
    if (cached !== undefined) {
      // Refresh recency: a Map iterates in insertion order.
      this.#cache.delete(sql);
      this.#cache.set(sql, cached);
      return cached;
    }
    const statement = this.#db.prepare(sql);
    const reader = statement.columns().length > 0;
    if (reader) statement.setReadBigInts(true);
    cached = { statement, reader, keyword: leadingKeyword(sql) };
    this.#cache.set(sql, cached);
    if (this.#cache.size > STATEMENT_CACHE_SIZE) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    return cached;
  }

  /** Run one statement. Throws node:sqlite's error unchanged, for the classifier. */
  execute(sql: string, params: readonly SqlValue[]): SqliteExecution {
    const { statement, reader, keyword } = this.#cached(sql);
    const bound = params.map(bindable);
    if (reader) {
      const rows = (statement.all(...bound) as Record<string, SqlValue>[]).map(narrowRow);
      return { rows, affected: isWriteKeyword(keyword) ? rows.length : 0 };
    }
    const result = statement.run(...bound);
    // `changes` keeps the last write's count through DDL, BEGIN and PRAGMA, so
    // only a write reports it. A WITH that returns no columns can only be a
    // WITH ... INSERT/UPDATE/DELETE.
    if (!isWriteKeyword(keyword) && keyword !== 'WITH') return { rows: [], affected: 0 };
    const affected = Number(result.changes);
    return (keyword === 'INSERT' || keyword === 'REPLACE') && affected > 0
      ? { rows: [], affected, insertId: narrow(result.lastInsertRowid) }
      : { rows: [], affected };
  }

  /** better-sqlite3's `prepare`, for TypeORM. */
  prepare(sql: string): CompatStatement {
    const { statement, reader } = this.#cached(sql);
    return {
      reader,
      all: (...params) =>
        (statement.all(...params.map(bindable)) as Record<string, SqlValue>[]).map(narrowRow),
      run: (...params) => statement.run(...params.map(bindable)),
    };
  }

  /** better-sqlite3's `pragma`: the rows of `PRAGMA <source>`. */
  pragma(source: string): unknown[] {
    const statement = this.#db.prepare(`PRAGMA ${source}`);
    if (statement.columns().length > 0) return statement.all();
    statement.run();
    return [];
  }

  /** Run SQL text without parameters (several statements allowed). */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /** Refuse the writes that can corrupt a database file (`writable_schema` and the like). */
  enableDefensive(): void {
    this.#db.enableDefensive(true);
  }

  close(): void {
    this.#cache.clear();
    if (this.#db.isOpen) this.#db.close();
  }
}
