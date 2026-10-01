/**
 * The bound engine `createEngine` returns: the dialect engine behind a thin
 * layer that makes every lease taken inside a transaction join it.
 *
 * `lease()` inside a `transaction()` of this engine takes no connection of
 * its own; it returns a view of the transaction's connection whose
 * `release()` does nothing. Each statement on the view runs in the frame of
 * that transaction bound to the async context it is issued from, so a view
 * leased in one frame and used in a nested one joins the nested frame
 * instead of waiting for it. With no frame of that transaction in its
 * context (detached work, or another transaction of the engine) a view
 * keeps to the frame it was leased in, and fails with `transaction.closed`
 * once that frame ended: a view never moves to another connection.
 *
 * Outside every transaction `lease()` takes an autocommit connection of its
 * own, and it stays that connection wherever its statements are issued
 * from. Session state (an advisory lock, a `SET`, a temporary table) lives
 * on a physical connection, so a lease redirected into a transaction would
 * see another session's. A write on such a lease from inside a transaction
 * therefore commits independently on a server, and waits for the writer
 * lock the transaction holds on SQLite, as detached work does.
 *
 * `begin()` inside a live transaction of this engine is refused
 * (`transaction.nested_begin`): it would open an independent transaction on
 * a server and wait on the transaction's own writer lock on SQLite.
 * `detached()` is the way to an independent transaction.
 */

import type {
  Conn,
  Dialect,
  Engine,
  QueryOptions,
  QueryResult,
  SqlValue,
  TransactionConn,
  TransactionOptions,
} from '../engine/contract.js';
import { DatabaseError } from '../engine/database-error.js';
import type { CompiledStatement, Statement } from '../engine/statement.js';
import type { Frame } from './frame.js';
import { TransactionErrors } from './transaction-errors.js';
import { boundFrame } from './transaction-scope.js';

/** Where a bound engine keeps what it binds; shared by duplicate package copies. */
const BINDING = Symbol.for('jsails.database.engineBinding.v1');

/** What `transaction()` needs from a bound engine. */
export interface EngineBinding {
  /** The dialect engine, which outermost transactions begin on. */
  readonly dialectEngine: Engine;
  /** How long a statement or nested frame waits for its frame; 0 waits forever. */
  readonly acquireTimeoutMs: number;
}

/** Options of {@link bindEngine}. */
export interface BindEngineOptions {
  /** The engine's acquire timeout, which bounds the wait for a transaction frame too. */
  readonly acquireTimeoutMs: number;
}

interface BoundEngineShape {
  readonly [BINDING]?: EngineBinding;
}

/** A view of a transaction's connection, leased inside one of its frames. */
class FrameConn implements Conn {
  #released = false;

  constructor(
    readonly dialect: Dialect,
    private readonly engine: Engine,
    /** The frame the lease was taken in. */
    private readonly home: Frame,
  ) {}

  query(
    sql: string,
    params: readonly SqlValue[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    if (this.#released) return Promise.reject(new DatabaseError('released'));
    const bound = boundFrame(this.engine);
    const frame = bound !== undefined && bound.scope === this.home.scope ? bound : this.home;
    return frame.query(sql, params, options);
  }

  release(): Promise<void> {
    this.#released = true;
    return Promise.resolve();
  }
}

class BoundEngine implements Engine, BoundEngineShape {
  readonly dialect: Dialect;
  readonly serverVersion: string;
  readonly bindLimit: number;
  readonly [BINDING]: EngineBinding;
  readonly #engine: Engine;

  constructor(engine: Engine, options: BindEngineOptions) {
    this.dialect = engine.dialect;
    this.serverVersion = engine.serverVersion;
    this.bindLimit = engine.bindLimit;
    this.#engine = engine;
    this[BINDING] = Object.freeze({
      dialectEngine: engine,
      acquireTimeoutMs: options.acquireTimeoutMs,
    });
  }

  async lease(): Promise<Conn> {
    const frame = boundFrame(this);
    if (frame !== undefined) {
      frame.assertLive();
      return new FrameConn(this.dialect, this, frame);
    }
    return this.#engine.lease();
  }

  async begin(options?: TransactionOptions): Promise<TransactionConn> {
    const frame = boundFrame(this);
    if (frame !== undefined) {
      frame.assertLive();
      throw new TransactionErrors.Error('nested_begin');
    }
    return this.#engine.begin(options);
  }

  compile(statement: Statement): CompiledStatement {
    return this.#engine.compile(statement);
  }

  close(): Promise<void> {
    return this.#engine.close();
  }
}

/** Bind a dialect engine's leases to the ambient transaction. */
export function bindEngine(engine: Engine, options: BindEngineOptions): Engine {
  return new BoundEngine(engine, options);
}

/**
 * What a bound engine binds: the dialect engine `transaction()` begins its
 * outermost frames on, and the wait bound of its frames.
 *
 * @throws `transaction.unbound_engine` for an engine `createEngine` did not open.
 */
export function engineBindingOf(engine: Engine): EngineBinding {
  const binding =
    typeof engine === 'object' && engine !== null
      ? (engine as BoundEngineShape)[BINDING]
      : undefined;
  if (binding === undefined) throw new TransactionErrors.Error('unbound_engine');
  return binding;
}
