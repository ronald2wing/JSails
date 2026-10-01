/**
 * `transaction()` and `withTestTransaction()`: the one way to run work in a
 * transaction on the data engine. Both take the engine, or a data source,
 * which opens its private engine for them.
 *
 * The outermost call begins a transaction on the engine and binds its body
 * to it, so every lease the body (and every promise it starts) takes joins
 * it; a nested call is always a savepoint frame. Isolation, read-only,
 * retry and timeout are options of the outermost call only, and inside
 * `withTestTransaction` isolation and read-only are refused. See `frame.ts`
 * for the rules a frame enforces (serialisation, poisoning, closing,
 * callbacks).
 */

import { setTimeout as sleep } from 'node:timers/promises';

import type { Engine, IsolationLevel, TransactionOptions } from '../engine/contract.js';
import { isDatabaseError } from '../engine/database-error.js';
import { engineBindingOf } from './bound-engine.js';
import { engineOf, type TransactionTarget } from './engine-source.js';
import { Frame, type Outcome } from './frame.js';
import {
  TransactionErrors,
  type OutermostOption,
  type TransactionArgument,
} from './transaction-errors.js';
import { boundFrame, runBound } from './transaction-scope.js';

/** The transaction a body runs in. */
export interface Tx {
  /**
   * 1 for the outermost transaction, plus one per nested `transaction()`.
   * Under `withTestTransaction` the first `transaction()` is depth 1, as it
   * is in production.
   */
  readonly depth: number;
  /**
   * Run `callback` once the outermost transaction committed, with its scope
   * removed: its statements on this engine run in autocommit, and those on
   * another engine still join that engine's open transaction. Dropped when
   * this frame or an enclosing one rolls back. Callbacks run one at a time
   * in registration order; their failures make `transaction()` reject with
   * `transaction.after_commit_failed`, although the data committed.
   */
  afterCommit(callback: () => unknown): void;
  /**
   * Run `callback` once this frame's work is rolled back: when this frame
   * rolls back, or when an enclosing frame does after this one released. It
   * runs in the nearest enclosing frame still open, so after a nested frame
   * its writes join the enclosing transaction; with none open, with the
   * scope removed, as afterCommit callbacks. Failures make `transaction()`
   * reject with `transaction.after_rollback_failed`, whose cause lists the
   * original failure first.
   */
  afterRollback(callback: () => unknown): void;
}

/** When to run a failed outermost transaction again. */
export interface TransactionRetry {
  /** The most times the body runs, the first included: 1 to 20. */
  readonly attempts: number;
  /**
   * Whether a failure is worth another run. Default: a transient
   * `DatabaseError` (deadlock, serialization failure, lock timeout, a busy
   * SQLite file), or `transaction.aborted` caused by one. A transaction
   * that committed (`transaction.after_commit_failed`) never runs again.
   */
  readonly on?: (error: unknown) => boolean;
  /**
   * The first wait between runs in milliseconds, doubling each time, with
   * jitter down to half of it; at most 30 seconds a wait. Default 20.
   */
  readonly backoffMs?: number;
}

/** Options of {@link transaction}; each applies to the outermost call only. */
export interface TransactionRunOptions extends TransactionOptions {
  /** Run the body again on a transient failure. The body must be safe to re-run. */
  readonly retry?: TransactionRetry;
  /**
   * Roll back and reject with `transaction.timeout` when the transaction is
   * still running after this many milliseconds; later statements of the body
   * fail with the same code. A statement already running finishes first,
   * bounded by the statement timeout.
   */
  readonly timeoutMs?: number;
}

interface Settings {
  readonly isolation: IsolationLevel | undefined;
  readonly readOnly: boolean | undefined;
  readonly retry: Required<TransactionRetry> | undefined;
  readonly timeoutMs: number | undefined;
  /** The outermost-only options given, in declaration order. */
  readonly outermostOptions: readonly OutermostOption[];
}

const ISOLATION_LEVELS: ReadonlySet<string> = new Set([
  'read committed',
  'repeatable read',
  'serializable',
]);
const OPTION_KEYS: ReadonlySet<string> = new Set(['isolation', 'readOnly', 'retry', 'timeoutMs']);
const RETRY_KEYS: ReadonlySet<string> = new Set(['attempts', 'on', 'backoffMs']);
const MAX_ATTEMPTS = 20;
const DEFAULT_BACKOFF_MS = 20;
const MAX_WAIT_MS = 30_000;
/** setTimeout's largest delay. */
const MAX_TIMEOUT_MS = 2_147_483_647;

function invalid(argument: TransactionArgument): Error {
  return new TransactionErrors.Error('invalid_arguments', { argument });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** A failure a retry may cure: transient, or an abort a transient failure caused. */
function isTransientFailure(error: unknown): boolean {
  if (isDatabaseError(error)) return error.transient;
  if (TransactionErrors.is(error, 'aborted')) {
    const cause: unknown = error.cause;
    return isDatabaseError(cause) && cause.transient;
  }
  return false;
}

function parseRetry(value: unknown): Required<TransactionRetry> {
  if (!isRecord(value) || Object.keys(value).some((key) => !RETRY_KEYS.has(key))) {
    throw invalid('retry');
  }
  if (!isIntegerIn(value.attempts, 1, MAX_ATTEMPTS)) throw invalid('retry.attempts');
  if (value.on !== undefined && typeof value.on !== 'function') throw invalid('retry.on');
  if (value.backoffMs !== undefined && !isIntegerIn(value.backoffMs, 0, MAX_WAIT_MS)) {
    throw invalid('retry.backoffMs');
  }
  return {
    attempts: value.attempts,
    on: (value.on as TransactionRetry['on']) ?? isTransientFailure,
    backoffMs: value.backoffMs ?? DEFAULT_BACKOFF_MS,
  };
}

function parseOptions(options: unknown): Settings {
  if (options === undefined) {
    return {
      isolation: undefined,
      readOnly: undefined,
      retry: undefined,
      timeoutMs: undefined,
      outermostOptions: [],
    };
  }
  if (!isRecord(options) || Object.keys(options).some((key) => !OPTION_KEYS.has(key))) {
    throw invalid('options');
  }
  const { isolation, readOnly, retry, timeoutMs } = options;
  if (
    isolation !== undefined &&
    (typeof isolation !== 'string' || !ISOLATION_LEVELS.has(isolation))
  ) {
    throw invalid('isolation');
  }
  if (readOnly !== undefined && typeof readOnly !== 'boolean') throw invalid('readOnly');
  if (timeoutMs !== undefined && !isIntegerIn(timeoutMs, 1, MAX_TIMEOUT_MS)) {
    throw invalid('timeoutMs');
  }
  const outermostOptions: OutermostOption[] = [];
  if (isolation !== undefined) outermostOptions.push('isolation');
  if (readOnly !== undefined) outermostOptions.push('readOnly');
  if (retry !== undefined) outermostOptions.push('retry');
  if (timeoutMs !== undefined) outermostOptions.push('timeoutMs');
  return {
    isolation: isolation as IsolationLevel | undefined,
    readOnly,
    retry: retry === undefined ? undefined : parseRetry(retry),
    timeoutMs,
    outermostOptions,
  };
}

function txOf(frame: Frame): Tx {
  return Object.freeze({
    depth: frame.depth,
    afterCommit: (callback: () => unknown) => {
      frame.register('commit', callback);
    },
    afterRollback: (callback: () => unknown) => {
      frame.register('rollback', callback);
    },
  });
}

/** Run `body` bound to `frame` and capture how it settled. */
async function settle<R>(
  engine: Engine,
  frame: Frame,
  body: () => R | Promise<R>,
): Promise<Outcome<R>> {
  try {
    return { ok: true, value: await runBound(engine, frame, body) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Run a frame's body and end the frame, racing an optional timeout. */
function runFrame<R>(
  engine: Engine,
  frame: Frame,
  body: (tx: Tx) => R | Promise<R>,
  timeoutMs: number | undefined,
): Promise<R> {
  const tx = txOf(frame);
  const finished = settle(engine, frame, () => body(tx)).then((outcome) => frame.finish(outcome));
  if (timeoutMs === undefined) return finished;
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      frame.expire().then((expired) => {
        if (expired === false) return;
        const timeout = new TransactionErrors.Error('timeout');
        if (expired.length === 0) {
          reject(timeout);
          return;
        }
        reject(
          new TransactionErrors.Error(
            'after_rollback_failed',
            { count: expired.length },
            {
              cause: new AggregateError(
                [timeout, ...expired],
                'the transaction timed out and after-rollback callbacks failed',
              ),
            },
          ),
        );
      }, reject);
    }, timeoutMs);
    // After an expiry `finished` rejects too, later; this promise has settled
    // by then and ignores it.
    finished.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runOnce<R>(
  engine: Engine,
  parent: Frame | undefined,
  body: (tx: Tx) => R | Promise<R>,
  settings: Settings,
): Promise<R> {
  if (parent !== undefined) {
    const frame = await parent.openChild();
    return runFrame(engine, frame, body, frame.outermost ? settings.timeoutMs : undefined);
  }
  const options: TransactionOptions = {
    ...(settings.isolation === undefined ? {} : { isolation: settings.isolation }),
    ...(settings.readOnly === undefined ? {} : { readOnly: settings.readOnly }),
  };
  const { dialectEngine, acquireTimeoutMs } = engineBindingOf(engine);
  const conn = await dialectEngine.begin(options);
  const frame = Frame.root({ engine, conn, virtual: false, acquireTimeoutMs });
  return runFrame(engine, frame, body, settings.timeoutMs);
}

/** The wait before run `attempt + 1`: exponential, with jitter down to half. */
function backoff(attempt: number, baseMs: number): number {
  const ceiling = Math.min(baseMs * 2 ** (attempt - 1), MAX_WAIT_MS);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/**
 * Run `body` in a transaction on `engine` and resolve with what it returned.
 * `target` is the engine, or a data source, whose engine opens on first use.
 *
 * Outside a transaction of `engine` this begins one: it commits when `body`
 * fulfils and rolls back when it rejects, rejecting with the same failure.
 * Inside one it opens a savepoint frame: its writes, buffered change records
 * and afterCommit callbacks are kept when it fulfils and discarded when it
 * rejects, while the enclosing transaction carries on.
 *
 * Every lease `engine` hands out inside `body`, and inside every promise it
 * starts, joins the transaction; a connection leased before it began stays a
 * connection of its own. Frames of one transaction run one at a time: a
 * statement issued in a frame while a nested frame is open inside it waits
 * for that frame to end, at most the engine's acquire timeout, then fails
 * with `transaction.frame_busy` (a nested frame awaiting that statement would
 * otherwise never end). After any failed statement the frame it ran
 * in is poisoned on every driver: further statements throw
 * `transaction.aborted`, and the frame rolls back even if `body` caught the
 * failure. Wrap a statement that may fail in a nested `transaction()` to
 * recover from it. Once the transaction ended, work still running from its
 * async context fails with `transaction.closed`; use `detached()` for work
 * meant to outlive it.
 *
 * @throws `transaction.outermost_only` when a nested call passes an option,
 *   `transaction.unsupported_in_test` for `isolation` or `readOnly: true`
 *   directly inside `withTestTransaction`,
 *   `transaction.invalid_arguments` for a malformed argument,
 *   `transaction.unbound_engine` for an engine `createEngine` did not open,
 *   `data_source.duplicate_package` for a data source of another copy of
 *   this package.
 */
export async function transaction<R>(
  target: TransactionTarget,
  body: (tx: Tx) => R | Promise<R>,
  options?: TransactionRunOptions,
): Promise<R> {
  const source = engineOf(target);
  const engine = source instanceof Promise ? await source : source;
  engineBindingOf(engine);
  if (typeof body !== 'function') throw invalid('body');
  const settings = parseOptions(options);
  const parent = boundFrame(engine);
  parent?.assertLive();
  const outermost = parent === undefined || parent.virtualRoot;
  if (!outermost && settings.outermostOptions.length > 0) {
    throw new TransactionErrors.Error('outermost_only', {
      argument: settings.outermostOptions[0] as OutermostOption,
    });
  }
  // A savepoint can neither raise the isolation level nor make the test
  // transaction read-only, so honouring these silently would let a test pass
  // where production refuses (a write in a read-only transaction).
  if (parent?.virtualRoot === true) {
    if (settings.isolation !== undefined) {
      throw new TransactionErrors.Error('unsupported_in_test', { argument: 'isolation' });
    }
    if (settings.readOnly === true) {
      throw new TransactionErrors.Error('unsupported_in_test', { argument: 'readOnly' });
    }
  }
  const retry = settings.retry;
  if (retry === undefined) return runOnce(engine, parent, body, settings);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runOnce(engine, parent, body, settings);
    } catch (error) {
      if (
        attempt >= retry.attempts ||
        TransactionErrors.is(error, 'after_commit_failed') ||
        !retry.on(error)
      ) {
        throw error;
      }
    }
    await sleep(backoff(attempt, retry.backoffMs));
  }
}

/**
 * Run `body` inside a transaction that always rolls back: everything it
 * wrote through `engine` (`target`, or the engine of the data source
 * `target`), on any lease, is gone afterwards. The default
 * wrapper of a data test.
 *
 * App code inside behaves as in production. A statement outside any
 * `transaction()` runs as if in autocommit (in a savepoint of its own, so a
 * caught failure leaves later statements working). A `transaction()` inside
 * is the outermost transaction app code sees (depth 1): when it fulfils its
 * afterCommit callbacks run at once, and when it rolls back or times out its
 * afterRollback callbacks do, still inside the test transaction, so their
 * writes roll back with it. `retry` and `timeoutMs` apply; `isolation` and
 * `readOnly: true` cannot be applied to a savepoint, so that `transaction()`
 * refuses them rather than run differently from production.
 *
 * @throws `transaction.nested_begin` inside a transaction of `engine`,
 *   `transaction.unbound_engine` for an engine `createEngine` did not open,
 *   `data_source.duplicate_package` for a data source of another copy of
 *   this package.
 */
export async function withTestTransaction<R>(
  target: TransactionTarget,
  body: () => R | Promise<R>,
): Promise<R> {
  const source = engineOf(target);
  const engine = source instanceof Promise ? await source : source;
  const { dialectEngine, acquireTimeoutMs } = engineBindingOf(engine);
  if (typeof body !== 'function') throw invalid('body');
  const enclosing = boundFrame(engine);
  if (enclosing !== undefined) {
    enclosing.assertLive();
    throw new TransactionErrors.Error('nested_begin');
  }
  const conn = await dialectEngine.begin();
  const frame = Frame.root({ engine, conn, virtual: true, acquireTimeoutMs });
  return frame.finish(await settle(engine, frame, body));
}
