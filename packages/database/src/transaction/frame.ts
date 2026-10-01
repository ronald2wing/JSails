/**
 * Transaction frames: the outermost transaction of a scope is its root frame,
 * and every nested `transaction()` is a savepoint frame on the same
 * connection. A frame owns the rules that make a transaction behave the same
 * on every driver:
 *
 * - Serialisation. A statement holds its frame's lock while it runs, and a
 *   nested frame holds its parent's lock from `SAVEPOINT` to its end, so only
 *   the innermost open frame runs statements, siblings never interleave
 *   savepoints, and statements of one frame run strictly in order. A
 *   statement or nested frame waits for its frame's lock at most the
 *   engine's acquire timeout, then fails with `frame_busy`: a statement
 *   started in a frame and awaited inside a nested frame opened after it
 *   would otherwise wait for that nested frame forever.
 * - Poisoning. After any failed statement the frame refuses every further
 *   statement, savepoint and nested frame with `aborted` until it rolls back.
 *   A failed savepoint rollback or release poisons every ancestor: the server
 *   ended the whole transaction.
 * - Closing. An ended frame refuses everything with `closed`, an expired one
 *   (and every frame inside it) with `timeout`.
 * - Callbacks and commit buffers. A frame's afterCommit callbacks and
 *   buffered items merge into its parent when it releases, and are dropped
 *   when it rolls back, when its afterRollback callbacks run instead; at the
 *   outermost commit the buffers are delivered and the callbacks run. They
 *   run where the frame's work now lives: bound to the nearest enclosing
 *   frame still open, or with this engine's binding removed when there is
 *   none (the bindings of other engines stay, so a callback's statements on
 *   another engine still join that engine's open transaction).
 * - Undos. The in-memory undos of the work a frame did (`registerUndo`)
 *   follow its afterRollback callbacks, but run newest first and before
 *   them: an undo puts back the state its own step found, so after two steps
 *   on one object the second step's undo must run before the first's, and an
 *   afterRollback callback sees every object as it was before the frame.
 *
 * Under `withTestTransaction` the root is virtual: it always rolls back, each
 * statement issued directly at its level runs in a savepoint of its own (an
 * emulated autocommit, so a caught failure there does not poison the test),
 * and a frame directly inside it is the outermost one app code sees: its
 * release delivers its buffers and runs its afterCommit callbacks at once,
 * and its rollback or timeout runs its afterRollback callbacks, all bound to
 * the virtual root, so their writes roll back with the test.
 */

import type {
  Engine,
  QueryOptions,
  QueryResult,
  Savepoint,
  SqlValue,
  TransactionConn,
} from '../engine/contract.js';
import { isDatabaseError } from '../engine/database-error.js';
import { FifoLock } from '../engine/fifo-lock.js';
import { TransactionErrors } from './transaction-errors.js';
import { runBound, runUnbound } from './transaction-scope.js';

/** A callback registered with `afterCommit` or `afterRollback`. */
export type FrameCallback = () => unknown;

/** Where a commit buffer's items go once their transaction committed. */
export interface CommitSink {
  deliver(items: readonly unknown[]): unknown;
}

/** How a frame's body settled. */
export type Outcome<R> =
  { readonly ok: true; readonly value: R } | { readonly ok: false; readonly error: unknown };

type FrameState = 'open' | 'ended' | 'expired';

/** What a frame's end produced, and what runs next. */
interface Ended<R> {
  readonly result: Outcome<R>;
  /**
   * `committed`: deliver buffers and run afterCommit callbacks here.
   * `rolled_back`: run afterRollback callbacks here. `merged`: hand the
   * callbacks to the parent frame, whose end decides.
   */
  readonly next: 'committed' | 'rolled_back' | 'merged';
}

/** One transaction scope: the connection its frames share. */
export interface FrameScope {
  readonly engine: Engine;
  readonly conn: TransactionConn;
  /** A `withTestTransaction` root: it always rolls back. */
  readonly virtual: boolean;
  /** How long a statement or nested frame waits for its frame; 0 waits forever. */
  readonly acquireTimeoutMs: number;
}

/** The value of several failures: the one, or an `AggregateError` of all. */
function combined(errors: readonly unknown[]): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, 'several callbacks failed');
}

/** Runs a function in the async context an ended frame's callbacks run in. */
type CallbackRunner = <T>(fn: () => T) => T;

/** Run callbacks one at a time, each to completion, and collect their failures. */
async function runCallbacks(
  callbacks: readonly FrameCallback[],
  run: CallbackRunner,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const callback of callbacks) {
    try {
      await run(callback);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** A frame lock that was not free within the acquire timeout. */
function frameBusy(error: unknown): never {
  if (isDatabaseError(error, 'acquire_timeout')) {
    throw new TransactionErrors.Error('frame_busy', {}, { cause: error });
  }
  throw error;
}

export class Frame {
  readonly #lock = new FifoLock(1);
  #afterCommit: FrameCallback[] = [];
  #afterRollback: FrameCallback[] = [];
  /** In-memory undos, oldest first; they run in reverse. */
  #undos: (() => void)[] = [];
  #buffers = new Map<CommitSink, unknown[]>();
  #failure: { readonly error: unknown } | undefined;
  #state: FrameState = 'open';
  /** Set once the frame started its commit or rollback; a timeout no longer applies. */
  #ending = false;
  /** Whether this frame still holds its parent's lock. */
  #holdsParent: boolean;

  private constructor(
    readonly scope: FrameScope,
    readonly parent: Frame | undefined,
    readonly savepoint: Savepoint | undefined,
  ) {
    this.#holdsParent = parent !== undefined;
  }

  /** The root frame of a new scope. */
  static root(scope: FrameScope): Frame {
    return new Frame(scope, undefined, undefined);
  }

  /** The frame's depth as app code sees it: 1 for its outermost transaction. */
  get depth(): number {
    return this.parent === undefined ? (this.scope.virtual ? 0 : 1) : this.parent.depth + 1;
  }

  /** A `withTestTransaction` root. */
  get virtualRoot(): boolean {
    return this.parent === undefined && this.scope.virtual;
  }

  /** The frame app code sees as its outermost transaction. */
  get outermost(): boolean {
    return this.parent === undefined ? !this.scope.virtual : this.parent.virtualRoot;
  }

  /** Why the frame or an enclosing one can no longer run anything, if it cannot. */
  #closedError(): Error | undefined {
    if (this.#state === 'expired') return new TransactionErrors.Error('timeout');
    if (this.#state === 'ended') return new TransactionErrors.Error('closed');
    return this.parent === undefined ? undefined : this.parent.#closedError();
  }

  /** Whether this frame or an enclosing one expired. */
  #expired(): boolean {
    return this.#state === 'expired' || (this.parent !== undefined && this.parent.#expired());
  }

  /** Throw unless the frame is open. */
  assertLive(): void {
    const closed = this.#closedError();
    if (closed !== undefined) throw closed;
  }

  /** Throw unless the frame is open and not poisoned. */
  assertUsable(): void {
    this.assertLive();
    if (this.#failure !== undefined) {
      throw new TransactionErrors.Error('aborted', {}, { cause: this.#failure.error });
    }
  }

  /** Run a connection call, poisoning the frame when it fails. */
  async #guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      // A call that failed because the transaction expired under it reports the expiry.
      if (this.#expired()) throw new TransactionErrors.Error('timeout', {}, { cause: error });
      this.#failure ??= { error };
      throw error;
    }
  }

  /** Take this frame's lock for a statement or a nested frame, bounded by the acquire timeout. */
  #acquire(): Promise<void> {
    return this.#lock.acquire(this.scope.acquireTimeoutMs).catch(frameBusy);
  }

  /** Run one statement in this frame. */
  async query(
    sql: string,
    params: readonly SqlValue[],
    options: QueryOptions,
  ): Promise<QueryResult> {
    this.assertUsable();
    await this.#acquire();
    try {
      this.assertUsable();
      if (this.virtualRoot) return await this.#autocommit(sql, params, options);
      return await this.#guard(() => this.scope.conn.query(sql, params, options));
    } finally {
      this.#lock.release();
    }
  }

  /** A statement at the virtual root, in a savepoint of its own. */
  async #autocommit(
    sql: string,
    params: readonly SqlValue[],
    options: QueryOptions,
  ): Promise<QueryResult> {
    const savepoint = await this.#guard(() => this.scope.conn.savepoint());
    let result: QueryResult;
    try {
      result = await this.scope.conn.query(sql, params, options);
    } catch (error) {
      try {
        await this.#guard(() => savepoint.rollback());
      } catch {
        // #guard poisoned the frame; the statement's own failure is the one to report.
      }
      throw error;
    }
    await this.#guard(() => savepoint.release());
    return result;
  }

  /** Open a savepoint frame inside this one; it holds this frame's lock until it ends. */
  async openChild(): Promise<Frame> {
    this.assertUsable();
    await this.#acquire();
    try {
      this.assertUsable();
      const savepoint = await this.#guard(() => this.scope.conn.savepoint());
      return new Frame(this.scope, this, savepoint);
    } catch (error) {
      this.#lock.release();
      throw error;
    }
  }

  /** Register a callback; refused once the frame ended. */
  register(kind: 'commit' | 'rollback', callback: FrameCallback): void {
    if (typeof callback !== 'function') {
      throw new TransactionErrors.Error('invalid_arguments', { argument: 'callback' });
    }
    this.assertLive();
    (kind === 'commit' ? this.#afterCommit : this.#afterRollback).push(callback);
  }

  /**
   * Register the undo of an in-memory change this frame's work made; it runs
   * if the frame's work rolls back, newest first, before the afterRollback
   * callbacks. Refused once the frame ended.
   */
  registerUndo(undo: () => void): void {
    if (typeof undo !== 'function') {
      throw new TransactionErrors.Error('invalid_arguments', { argument: 'callback' });
    }
    this.assertLive();
    this.#undos.push(undo);
  }

  /** Buffer an item for delivery at the outermost commit; refused once the frame ended. */
  buffer(sink: CommitSink, item: unknown): void {
    this.assertLive();
    const items = this.#buffers.get(sink);
    if (items === undefined) this.#buffers.set(sink, [item]);
    else items.push(item);
  }

  #releaseParent(): void {
    if (!this.#holdsParent) return;
    this.#holdsParent = false;
    if (this.parent !== undefined) this.parent.#lock.release();
  }

  /** Take over a released child's callbacks and buffers. */
  #adopt(child: Frame): void {
    this.#afterCommit.push(...child.#afterCommit);
    this.#afterRollback.push(...child.#afterRollback);
    this.#undos.push(...child.#undos);
    for (const [sink, items] of child.#buffers) {
      const own = this.#buffers.get(sink);
      if (own === undefined) this.#buffers.set(sink, [...items]);
      else own.push(...items);
    }
  }

  /** Take over a child's afterRollback callbacks and undos: its work rolls back here. */
  #adoptRollback(child: Frame): void {
    this.#afterRollback.push(...child.#afterRollback);
    this.#undos.push(...child.#undos);
  }

  /** Poison this frame and every one enclosing it. */
  #poisonChain(error: unknown): void {
    this.#failure ??= { error };
    if (this.parent !== undefined) this.parent.#poisonChain(error);
  }

  /**
   * Run `fn` where this frame's callbacks and buffer deliveries run once it
   * ended: bound to the nearest enclosing frame still open (a virtual root,
   * or the transaction a rolled-back savepoint belonged to), so their writes
   * stay inside it; with this engine's binding removed when no enclosing
   * frame is open, so their statements run in autocommit.
   */
  readonly #afterEnd: CallbackRunner = (fn) => {
    let enclosing = this.parent;
    while (enclosing !== undefined && enclosing.#state !== 'open') enclosing = enclosing.parent;
    const engine = this.scope.engine;
    return enclosing === undefined ? runUnbound(engine, fn) : runBound(engine, enclosing, fn);
  };

  /** Deliver buffers, then run afterCommit callbacks; resolves with the failures. */
  async #committed(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const [sink, items] of this.#buffers) {
      try {
        await this.#afterEnd(() => sink.deliver(items));
      } catch (error) {
        failures.push(error);
      }
    }
    failures.push(...(await runCallbacks(this.#afterCommit, this.#afterEnd)));
    this.#clearCallbacks();
    return failures;
  }

  /** Run the undos newest first, then the afterRollback callbacks; resolves with the failures. */
  async #rolledBack(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const undo of this.#undos.toReversed()) {
      try {
        undo();
      } catch (error) {
        failures.push(error);
      }
    }
    failures.push(...(await runCallbacks(this.#afterRollback, this.#afterEnd)));
    this.#clearCallbacks();
    return failures;
  }

  #clearCallbacks(): void {
    this.#afterCommit = [];
    this.#afterRollback = [];
    this.#undos = [];
    this.#buffers = new Map();
  }

  /**
   * End the frame after its body settled: commit or release when the body
   * fulfilled and nothing poisoned the frame, roll back otherwise. Resolves
   * with the body's value or rejects with what `transaction()` rejects with.
   */
  async finish<R>(outcome: Outcome<R>): Promise<R> {
    // Waits for statements still running and for frames still open inside,
    // without a bound: the body settled, so none of them can be waiting on it.
    await this.#lock.acquire(0);
    let ended: Ended<R>;
    try {
      const closed = this.#closedError();
      if (closed === undefined) {
        this.#ending = true;
        ended = await this.#end(outcome);
      } else {
        // Expired (its timeout already answered), or inside a frame that
        // expired: everything here rolled back with it.
        if (this.#state === 'open') this.#state = 'ended';
        ended = { result: { ok: false, error: closed }, next: 'rolled_back' };
      }
    } finally {
      this.#lock.release();
    }
    return this.#settle(ended);
  }

  /** The commit, release or rollback itself, under the frame's own lock. */
  async #end<R>(outcome: Outcome<R>): Promise<Ended<R>> {
    // A virtual root always rolls back and answers with the body's outcome:
    // the statements that met its poisoning already failed in the body.
    const failure = this.virtualRoot ? undefined : this.#failure;
    const rejected: Outcome<R> | undefined = !outcome.ok
      ? outcome
      : failure === undefined
        ? undefined
        : {
            ok: false,
            error: new TransactionErrors.Error('aborted', {}, { cause: failure.error }),
          };
    const keep = rejected === undefined && !this.virtualRoot;
    const parent = this.parent;
    if (parent === undefined) {
      try {
        if (keep) await this.scope.conn.commit();
        else await this.scope.conn.rollback();
      } catch (error) {
        // A failed COMMIT rolled back; a failed ROLLBACK discards the
        // connection, and the server rolls back when the session ends. Either
        // way nothing committed.
        this.#state = 'ended';
        return { result: keep ? { ok: false, error } : (rejected ?? outcome), next: 'rolled_back' };
      }
      this.#state = 'ended';
      return keep
        ? { result: outcome, next: 'committed' }
        : { result: rejected ?? outcome, next: 'rolled_back' };
    }
    const savepoint = this.savepoint as Savepoint;
    try {
      if (keep) await savepoint.release();
      else await savepoint.rollback();
    } catch (error) {
      // The savepoint could not end: the server ended the whole transaction,
      // so no enclosing frame may commit, and this frame's work is gone with
      // it. A real parent runs this frame's afterRollback callbacks when it
      // rolls back; a virtual root never does, so they run here.
      this.#state = 'ended';
      parent.#poisonChain(error);
      return {
        result: rejected ?? { ok: false, error },
        next: parent.virtualRoot ? 'rolled_back' : 'merged',
      };
    }
    this.#state = 'ended';
    if (!keep) return { result: rejected ?? outcome, next: 'rolled_back' };
    return { result: outcome, next: parent.virtualRoot ? 'committed' : 'merged' };
  }

  /** Run what follows the end, outside the frame's lock, and produce the result. */
  async #settle<R>({ result, next }: Ended<R>): Promise<R> {
    if (next === 'merged') {
      // Released into a real enclosing frame, or lost with it: the outermost
      // end decides what runs.
      const parent = this.parent as Frame;
      if (result.ok) parent.#adopt(this);
      else parent.#adoptRollback(this);
      this.#clearCallbacks();
      this.#releaseParent();
      if (result.ok) return result.value;
      throw result.error;
    }
    this.#releaseParent();
    if (next === 'committed' && result.ok) {
      const failures = await this.#committed();
      if (failures.length > 0) {
        throw new TransactionErrors.Error(
          'after_commit_failed',
          { count: failures.length },
          { cause: combined(failures) },
        );
      }
      return result.value;
    }
    const callbackFailures = await this.#rolledBack();
    if (callbackFailures.length > 0) {
      throw new TransactionErrors.Error(
        'after_rollback_failed',
        { count: callbackFailures.length },
        {
          cause: new AggregateError(
            result.ok ? callbackFailures : [result.error, ...callbackFailures],
            'the transaction rolled back and after-rollback callbacks failed',
          ),
        },
      );
    }
    if (result.ok) return result.value;
    throw result.error;
  }

  /**
   * Roll back an app-outermost frame whose timeout fired, without waiting for
   * its body. Resolves `false` when the frame had already started ending (the
   * timeout no longer applies), else with the afterRollback failures.
   */
  async expire(): Promise<false | unknown[]> {
    if (this.#state !== 'open' || this.#ending) return false;
    this.#state = 'expired';
    try {
      if (this.parent === undefined) await this.scope.conn.rollback();
      else await (this.savepoint as Savepoint).rollback();
    } catch (error) {
      // A failed ROLLBACK discards the connection; a failed savepoint
      // rollback means the server ended the enclosing transaction.
      if (this.parent !== undefined) this.parent.#poisonChain(error);
    }
    this.#releaseParent();
    return this.#rolledBack();
  }
}
