/**
 * The {@link Conn} and {@link TransactionConn} every engine hands out. An
 * engine supplies a {@link LeaseHandle} (how to run a statement on what it
 * leased, and how to give it back); this module adds what is the same on
 * every dialect: parameter validation, the query ledger, the released state,
 * and the transaction-control statements with their savepoint stack.
 *
 * `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `ROLLBACK TO SAVEPOINT` and `RELEASE
 * SAVEPOINT` are spelled the same on all three dialects, so only `BEGIN`
 * differs and stays in the engines.
 */

import { performance } from 'node:perf_hooks';

import type {
  Conn,
  Dialect,
  QueryOptions,
  QueryResult,
  Row,
  Savepoint,
  SqlValue,
  TransactionConn,
} from './contract.js';
import { DatabaseError, isDatabaseError, type DatabaseErrorCode } from './database-error.js';
import { ledgerActive, recordStatement } from './query-ledger.js';

/** A statement's outcome as an engine reports it. */
export interface RawResult {
  readonly rows: Row[];
  readonly affected: number;
  readonly insertId?: number | bigint;
  /** PostgreSQL's command tag (`COMMIT`, `ROLLBACK`, ...); unset elsewhere. */
  readonly command?: string;
}

/** What an engine leased for one caller. */
export interface LeaseHandle {
  /** Run one statement; failures are already classified `DatabaseError`s. */
  run(sql: string, params: readonly SqlValue[]): Promise<RawResult>;
  /**
   * Give the lease back. `discard` asks for the physical connection to be
   * destroyed instead of reused, because its session state is unknown.
   */
  end(discard: boolean): Promise<void>;
  /**
   * Called after a statement inside a transaction failed: whether the server
   * ended the whole transaction. MariaDB rolls back the transaction of a
   * deadlock victim and SQLite that of some failures (`RAISE(ROLLBACK)`, a
   * full disk), then runs later statements in autocommit mode, so without
   * this check they would commit one by one and `COMMIT` would succeed.
   * PostgreSQL needs none: it refuses every statement of an aborted
   * transaction and answers its `COMMIT` with `ROLLBACK`.
   */
  transactionLost?(): Promise<boolean>;
}

/** Refusals raised before a statement reached the database; they cannot end a transaction. */
const PRE_FLIGHT_CODES: ReadonlySet<DatabaseErrorCode> = new Set([
  'invalid_statement',
  'invalid_parameter',
  'too_many_parameters',
  'unsupported_statement',
  'released',
]);

const DEFAULT_ORIGIN = 'app';
const ENGINE_ORIGIN = 'engine';

function assertParams(params: readonly SqlValue[]): void {
  if (!Array.isArray(params)) throw new DatabaseError('invalid_parameter', { field: 'params' });
  for (let index = 0; index < params.length; index += 1) {
    const value: unknown = params[index];
    const kind = typeof value;
    const bindable =
      value === null ||
      kind === 'string' ||
      kind === 'bigint' ||
      kind === 'boolean' ||
      (kind === 'number' && Number.isFinite(value)) ||
      value instanceof Uint8Array;
    if (!bindable) throw new DatabaseError('invalid_parameter', { field: `params[${index}]` });
  }
}

export class LeasedConn implements Conn {
  #released = false;
  #ending: Promise<void> | undefined;
  readonly #inflight = new Set<Promise<RawResult>>();

  /**
   * @param source The dialect engine that leased the connection; the query
   *   ledger scopes `countStatements` to one engine by it.
   */
  constructor(
    readonly dialect: Dialect,
    protected readonly handle: LeaseHandle,
    private readonly source: object,
  ) {}

  get released(): boolean {
    return this.#released;
  }

  async query(
    sql: string,
    params: readonly SqlValue[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    if (this.#released) throw new DatabaseError('released');
    if (typeof sql !== 'string' || sql.trim() === '') {
      throw new DatabaseError('invalid_statement', { field: 'sql' });
    }
    assertParams(params);
    const raw = await this.run(sql, params, options.origin ?? DEFAULT_ORIGIN);
    return raw.insertId === undefined
      ? Object.freeze({ rows: raw.rows, affected: raw.affected })
      : Object.freeze({ rows: raw.rows, affected: raw.affected, insertId: raw.insertId });
  }

  /** Run a statement and record it in the active ledgers, whether or not it fails. */
  protected run(sql: string, params: readonly SqlValue[], origin: string): Promise<RawResult> {
    const running = this.#record(sql, params, origin);
    this.#inflight.add(running);
    const settle = (): void => {
      this.#inflight.delete(running);
    };
    running.then(settle, settle);
    return running;
  }

  async #record(sql: string, params: readonly SqlValue[], origin: string): Promise<RawResult> {
    if (!ledgerActive()) return this.handle.run(sql, params);
    const started = performance.now();
    try {
      return await this.handle.run(sql, params);
    } finally {
      recordStatement(sql, performance.now() - started, origin, this.source);
    }
  }

  /** Run an engine-issued statement (transaction control). */
  protected control(sql: string): Promise<RawResult> {
    return this.run(sql, [], ENGINE_ORIGIN);
  }

  /**
   * Mark released and end the lease once; later calls share the first. A
   * statement still running finishes first, so a connection never goes back
   * to the pool with a query in flight.
   */
  protected finish(discard: boolean): Promise<void> {
    this.#released = true;
    this.#ending ??= this.#end(discard);
    return this.#ending;
  }

  async #end(discard: boolean): Promise<void> {
    if (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
    await this.handle.end(discard);
  }

  release(): Promise<void> {
    return this.finish(false);
  }
}

export class LeasedTransaction extends LeasedConn implements TransactionConn {
  readonly #savepoints: string[] = [];
  #savepointCount = 0;
  #releasing: Promise<void> | undefined;
  /** Set once the server ended the transaction on its own after a failure. */
  #lost = false;

  #assertOpen(): void {
    if (this.released || this.#releasing !== undefined) throw new DatabaseError('released');
    if (this.#lost) throw new DatabaseError('transaction_aborted');
  }

  override async query(
    sql: string,
    params: readonly SqlValue[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    this.#assertOpen();
    try {
      return await super.query(sql, params, options);
    } catch (error) {
      await this.#checkLost(error);
      throw error;
    }
  }

  /** After a failed statement, ask the engine whether the transaction survived it. */
  async #checkLost(error: unknown): Promise<void> {
    if (this.handle.transactionLost === undefined) return;
    if (isDatabaseError(error) && PRE_FLIGHT_CODES.has(error.code)) return;
    try {
      if (await this.handle.transactionLost()) this.#lost = true;
    } catch {
      // The probe itself failed: the session is unusable, so no statement of
      // this transaction may run, and its COMMIT must not report success.
      this.#lost = true;
    }
  }

  async savepoint(): Promise<Savepoint> {
    this.#assertOpen();
    this.#savepointCount += 1;
    const name = `jsails_sp_${this.#savepointCount}`;
    await this.control(`SAVEPOINT ${name}`);
    this.#savepoints.push(name);
    return Object.freeze({
      rollback: () => this.#endSavepoint(name, true),
      release: () => this.#endSavepoint(name, false),
    });
  }

  /** End `name` and every savepoint opened inside it. */
  async #endSavepoint(name: string, rollback: boolean): Promise<void> {
    this.#assertOpen();
    const index = this.#savepoints.lastIndexOf(name);
    if (index === -1) throw new DatabaseError('invalid_state', { field: 'savepoint' });
    if (rollback) await this.control(`ROLLBACK TO SAVEPOINT ${name}`);
    await this.control(`RELEASE SAVEPOINT ${name}`);
    this.#savepoints.length = index;
  }

  async commit(): Promise<void> {
    if (this.#lost && !this.released && this.#releasing === undefined) {
      // The server already rolled the transaction back; COMMIT would either
      // fail (SQLite) or succeed on nothing (MariaDB).
      await this.finish(false);
      throw new DatabaseError('transaction_aborted');
    }
    this.#assertOpen();
    let result: RawResult;
    try {
      result = await this.control('COMMIT');
    } catch (error) {
      // A failed COMMIT may leave the transaction open (a deferred constraint
      // on SQLite); roll it back so the connection is reusable.
      await this.#rollbackAndEnd();
      throw error;
    }
    if (result.command === 'ROLLBACK') {
      // PostgreSQL answers COMMIT of an aborted transaction with ROLLBACK.
      await this.finish(false);
      throw new DatabaseError('transaction_aborted');
    }
    await this.finish(false);
  }

  async rollback(): Promise<void> {
    if (this.released || this.#releasing !== undefined) throw new DatabaseError('released');
    if (this.#lost) {
      await this.finish(false);
      return;
    }
    let failure: unknown;
    try {
      await this.control('ROLLBACK');
    } catch (error) {
      failure = error;
    }
    await this.finish(failure !== undefined);
    if (failure !== undefined) throw failure;
  }

  async #rollbackAndEnd(): Promise<void> {
    if (this.#lost) {
      await this.finish(false);
      return;
    }
    let discard = false;
    try {
      await this.control('ROLLBACK');
    } catch {
      // The session is in an unknown state; the connection is discarded below
      // instead of being returned to the pool.
      discard = true;
    }
    await this.finish(discard);
  }

  override release(): Promise<void> {
    if (this.released) return this.finish(false);
    this.#releasing ??= this.#rollbackAndEnd();
    return this.#releasing;
  }
}
