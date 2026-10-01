/**
 * The SQLite engine: node:sqlite through TypeORM's `better-sqlite3` driver,
 * with a concurrency model for a synchronous database.
 *
 * Every handle is one zero-entity TypeORM DataSource over a
 * {@link NodeSqliteDatabase}. On a file:
 *
 * - One writer handle, behind a FIFO lock. A write transaction holds the lock
 *   from `BEGIN IMMEDIATE` to its end; an autocommit write holds it for one
 *   statement. Writers in this process therefore never contend inside SQLite.
 * - One shared read-only handle for autocommit reads. A statement runs to
 *   completion synchronously, so sharing it needs no lock, and in WAL mode it
 *   reads the last committed state without waiting for an open write
 *   transaction. A write sent there by mistake fails read-only and is retried
 *   on the writer.
 * - One read-only handle per read-only transaction, opened on first need and
 *   kept for reuse, at most {@link MAX_READ_TRANSACTIONS} at once.
 *
 * `:memory:` is one handle with everything behind the lock: a second
 * connection would be a different database.
 *
 * Another process may hold the file's write lock. SQLite's own busy wait
 * would block the event loop, so the busy timeout is 0 and a `SQLITE_BUSY`
 * statement is retried asynchronously with backoff until `busyTimeoutMs`,
 * then fails as `busy`. A busy statement did nothing, so a retry is safe.
 *
 * WAL, `synchronous = NORMAL` (durable at checkpoints, never corrupt), foreign
 * keys on, and defensive mode are set on open. There is no statement timeout:
 * a synchronous statement cannot be interrupted from JavaScript.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import type { DataSource } from 'typeorm';

import type { Conn, Engine, SqlValue, TransactionConn, TransactionOptions } from '../contract.js';
import type { DatabaseConfig } from '../config.js';
import { MEMORY_DATABASE } from '../config.js';
import { DatabaseError, isDatabaseError } from '../database-error.js';
import { classifyDriverError, isSqliteBusy } from '../error-codes.js';
import { FifoLock } from '../fifo-lock.js';
import { LeasedConn, LeasedTransaction, type RawResult } from '../leased-conn.js';
import { BIND_LIMITS, compileStatement } from '../render.js';
import { leadingKeyword } from '../sql-keyword.js';
import type { CompiledStatement, Statement } from '../statement.js';
import { assertVersionFloor } from '../version-floor.js';
import { NodeSqliteDatabase } from './node-sqlite-adapter.js';

/** The most read-only transactions open at once, each on its own handle. */
export const MAX_READ_TRANSACTIONS = 4;

const MAX_BACKOFF_MS = 50;

/** Every level is accepted: SQLite transactions are serializable, which satisfies each. */
const ISOLATION_LEVELS: ReadonlySet<string> = new Set([
  'read committed',
  'repeatable read',
  'serializable',
]);

/** Statements that go to the shared reader when outside a transaction. */
const READ_KEYWORDS: ReadonlySet<string> = new Set(['SELECT', 'VALUES', 'WITH', 'EXPLAIN']);

class SqliteHandle {
  constructor(
    private readonly dataSource: DataSource,
    readonly db: NodeSqliteDatabase,
  ) {}

  static async open(file: string, role: 'writer' | 'reader'): Promise<SqliteHandle> {
    const { DataSource } = await import('typeorm');
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: file,
      driver: NodeSqliteDatabase,
      readonly: role === 'reader',
      entities: [],
      subscribers: [],
      migrations: [],
      synchronize: false,
      logging: false,
      statementCacheSize: 0,
      prepareDatabase: (db: NodeSqliteDatabase) => {
        db.enableDefensive();
        if (role === 'writer' && file !== MEMORY_DATABASE) {
          db.pragma('journal_mode = WAL');
          db.pragma('synchronous = NORMAL');
        }
      },
    });
    try {
      await dataSource.initialize();
    } catch (error) {
      throw classifyDriverError(error, 'sqlite', 'connect');
    }
    // The driver's query runner hands back the connection it opened: the adapter.
    const db = (await dataSource.createQueryRunner().connect()) as NodeSqliteDatabase;
    return new SqliteHandle(dataSource, db);
  }

  async close(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}

class SqliteEngine implements Engine {
  readonly dialect = 'sqlite' as const;
  readonly bindLimit: number = BIND_LIMITS.sqlite;
  readonly #memory: boolean;
  readonly #writerLock = new FifoLock(1);
  readonly #readSlots = new FifoLock(MAX_READ_TRANSACTIONS);
  readonly #idleReaders: SqliteHandle[] = [];
  readonly #readHandles = new Set<SqliteHandle>();
  #sharedReader: Promise<SqliteHandle> | undefined;
  /** Unset after a writer was closed with its transaction stuck and could not reopen. */
  #writer: SqliteHandle | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(
    private readonly config: DatabaseConfig,
    private readonly file: string,
    writer: SqliteHandle,
    readonly serverVersion: string,
  ) {
    this.#memory = file === MEMORY_DATABASE;
    this.#writer = writer;
  }

  compile(statement: Statement): CompiledStatement {
    return compileStatement(statement, 'sqlite');
  }

  #assertOpen(): void {
    if (this.#closed) throw new DatabaseError('closed');
  }

  /** Run `fn` on a handle, retrying while another process holds the file. */
  async #retryBusy<T>(fn: () => T): Promise<T> {
    const deadline = Date.now() + this.config.busyTimeoutMs;
    let backoff = 1;
    for (;;) {
      this.#assertOpen();
      try {
        return fn();
      } catch (error) {
        const remaining = deadline - Date.now();
        if (!isSqliteBusy(error) || remaining <= 0) throw classifyDriverError(error, 'sqlite');
        await sleep(Math.min(backoff, remaining));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  #execute(handle: SqliteHandle, sql: string, params: readonly SqlValue[]): Promise<RawResult> {
    return this.#retryBusy(() => handle.db.execute(sql, params));
  }

  #reader(): Promise<SqliteHandle> {
    this.#sharedReader ??= SqliteHandle.open(this.file, 'reader').then(
      async (handle) => {
        if (this.#closed) {
          // close() ran while the handle was opening and could not see it.
          await handle.close();
          throw new DatabaseError('closed');
        }
        this.#readHandles.add(handle);
        return handle;
      },
      (error: unknown) => {
        // Let the next read try again instead of failing forever.
        this.#sharedReader = undefined;
        throw error;
      },
    );
    return this.#sharedReader;
  }

  /** Take the writer lock and the writer, reopening a writer that was lost. */
  async #acquireWriter(): Promise<SqliteHandle> {
    await this.#writerLock.acquire(this.config.acquireTimeoutMs);
    try {
      this.#assertOpen();
      if (this.#writer === undefined) {
        const opened = await SqliteHandle.open(this.file, 'writer');
        if (this.#closed) {
          await opened.close();
          throw new DatabaseError('closed');
        }
        this.#writer = opened;
      }
      return this.#writer;
    } catch (error) {
      this.#writerLock.release();
      throw error;
    }
  }

  /** One autocommit statement on the writer, holding the writer lock. */
  async #writeAutocommit(sql: string, params: readonly SqlValue[]): Promise<RawResult> {
    const writer = await this.#acquireWriter();
    try {
      return await this.#execute(writer, sql, params);
    } finally {
      this.#writerLock.release();
    }
  }

  async #runAutocommit(sql: string, params: readonly SqlValue[]): Promise<RawResult> {
    this.#assertOpen();
    if (!this.#memory && READ_KEYWORDS.has(leadingKeyword(sql))) {
      const reader = await this.#reader();
      try {
        return await this.#execute(reader, sql, params);
      } catch (error) {
        if (!isDatabaseError(error, 'read_only')) throw error;
        // A WITH ... INSERT and the like: it writes, so it belongs on the writer.
      }
    }
    return this.#writeAutocommit(sql, params);
  }

  async lease(): Promise<Conn> {
    this.#assertOpen();
    return new LeasedConn('sqlite', {
      run: (sql, params) => this.#runAutocommit(sql, params),
      end: () => Promise.resolve(),
    });
  }

  async begin(options: TransactionOptions = {}): Promise<TransactionConn> {
    this.#assertOpen();
    if (options.isolation !== undefined && !ISOLATION_LEVELS.has(options.isolation)) {
      throw new DatabaseError('invalid_statement', { field: 'isolation' });
    }
    if (options.readOnly === true && !this.#memory) return this.#beginReadOnly();
    return this.#beginOnWriter(options.readOnly === true);
  }

  async #beginOnWriter(readOnly: boolean): Promise<TransactionConn> {
    const writer = await this.#acquireWriter();
    try {
      // query_only makes a read-only transaction on the one :memory: handle
      // refuse writes, as a read-only handle does on a file.
      if (readOnly) writer.db.pragma('query_only = ON');
      await this.#retryBusy(() => writer.db.exec(readOnly ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE'));
    } catch (error) {
      await this.#endWriter(writer, readOnly);
      throw classifyDriverError(error, 'sqlite');
    }
    return new LeasedTransaction('sqlite', {
      run: (sql, params) => this.#execute(writer, sql, params),
      end: () => this.#endWriter(writer, readOnly),
      // Some failures (RAISE(ROLLBACK), a full disk) end the transaction.
      transactionLost: () => Promise.resolve(!writer.db.inTransaction),
    });
  }

  /** End a writer transaction and hand the writer lock on. */
  async #endWriter(writer: SqliteHandle, readOnly: boolean): Promise<void> {
    try {
      if (writer.db.open && writer.db.inTransaction) {
        try {
          writer.db.exec('ROLLBACK');
        } catch {
          // Checked below: a writer still inside a transaction is replaced.
        }
      }
      if (writer.db.open && writer.db.inTransaction && !this.#memory && !this.#closed) {
        // Closing the handle rolls the transaction back; a fresh writer takes
        // its place (opened by the next lock holder) so no BEGIN finds a
        // transaction open.
        this.#writer = undefined;
        await writer.close();
      } else if (readOnly && writer.db.open) {
        writer.db.pragma('query_only = OFF');
      }
    } finally {
      this.#writerLock.release();
    }
  }

  async #beginReadOnly(): Promise<TransactionConn> {
    await this.#readSlots.acquire(this.config.acquireTimeoutMs);
    let handle: SqliteHandle;
    try {
      handle = this.#idleReaders.pop() ?? (await SqliteHandle.open(this.file, 'reader'));
    } catch (error) {
      this.#readSlots.release();
      throw error;
    }
    if (this.#closed) {
      // close() ran while the handle was opening and could not see it.
      await handle.close();
      throw new DatabaseError('closed');
    }
    this.#readHandles.add(handle);
    try {
      await this.#retryBusy(() => handle.db.exec('BEGIN DEFERRED'));
      // A deferred transaction takes its snapshot at the first read; take it now.
      await this.#execute(handle, 'SELECT 1 FROM sqlite_schema LIMIT 1', []);
    } catch (error) {
      await this.#endReader(handle, true);
      throw error;
    }
    return new LeasedTransaction('sqlite', {
      run: (sql, params) => this.#execute(handle, sql, params),
      end: (discard) => this.#endReader(handle, discard),
      transactionLost: () => Promise.resolve(!handle.db.inTransaction),
    });
  }

  async #endReader(handle: SqliteHandle, discard: boolean): Promise<void> {
    try {
      if (handle.db.open && handle.db.inTransaction) handle.db.exec('ROLLBACK');
    } catch {
      // Discarded below: a handle whose transaction did not end is not reused.
      discard = true;
    }
    if (discard || this.#closed) {
      this.#readHandles.delete(handle);
      await handle.close();
    } else {
      this.#idleReaders.push(handle);
    }
    this.#readSlots.release();
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#writerLock.close();
    this.#readSlots.close();
    const handles = [...(this.#writer === undefined ? [] : [this.#writer]), ...this.#readHandles];
    this.#readHandles.clear();
    this.#idleReaders.length = 0;
    // Closing a handle with an open transaction rolls it back.
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

/** Open the SQLite engine for `config` (whose `dialect` is `sqlite`). */
export async function openSqliteEngine(config: DatabaseConfig): Promise<Engine> {
  const file = config.file;
  if (config.dialect !== 'sqlite' || file === undefined) {
    throw new DatabaseError('invalid_config', { field: 'file' });
  }
  const writer = await SqliteHandle.open(file, 'writer');
  try {
    const { rows } = writer.db.execute('SELECT sqlite_version() AS version', []);
    const version = String(rows[0]?.version ?? '');
    assertVersionFloor('sqlite', version);
    return new SqliteEngine(config, file, writer, version);
  } catch (error) {
    await writer.close();
    throw error;
  }
}
