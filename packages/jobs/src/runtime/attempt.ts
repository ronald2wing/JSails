/**
 * One attempt's signal, deadline and hold rule.
 *
 * The attempt's signal aborts when the worker shuts down (the adapter's
 * signal), when the job's `timeoutMs` passes, or when the attempt loses its
 * overlap lease ({@link Attempt.loseLease}), whichever comes first, and
 * {@link Attempt.cause} records which one did. The cause is decided by the
 * source that aborted, never by what the handler rejected with: a cooperative
 * handler rejects with the signal's reason, and the shutdown reason
 * (`jobs.worker_aborted`) would otherwise read as a retryable failure.
 *
 * {@link Attempt.hold} never resolves before the attempt's own code settles,
 * so the adapter keeps holding the job (its slot and its lock) and the job
 * never runs alongside its own abandoned attempt. Once the signal aborts and
 * the code keeps running, the grace starts: past `handlerGraceMs` the worker
 * is poisoned ({@link AttemptLedger.poison}), and the process is expected to
 * exit with the attempt still held. On a shared transport the lock lapses only
 * after its holder is gone, so the job is redelivered only then.
 *
 * Every timer runs on the runtime's clock and is cleared by
 * {@link Attempt.dispose}, so a settled attempt leaves nothing pending.
 */

import { JobsErrors } from '../errors/jobs-errors.js';
import { setLongTimeout, type JobsClock, type LongTimer } from '../timing/long-timer.js';

/** What a worker keeps for its attempts: how many are held, and the poison trigger. */
export interface AttemptLedger {
  /** An attempt started; always paired with {@link leave}. */
  enter(): void;
  /** An attempt's code settled. */
  leave(): void;
  /** An abandoned attempt outlived its grace. Idempotent. */
  poison(): void;
}

/** Why an attempt's signal aborted. */
export type AbortCause = 'shutdown' | 'timeout' | 'lease_lost';

/** How the attempt's code settled. */
export type Settled<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** What an {@link Attempt} is built from. */
export interface AttemptOptions {
  /** The adapter's signal: aborts only when the worker shuts down. */
  readonly shutdown: AbortSignal;
  readonly timeoutMs: number | undefined;
  readonly clock: JobsClock;
  readonly handlerGraceMs: number;
  readonly ledger: AttemptLedger;
}

const ABORTED: unique symbol = Symbol('aborted');

export class Attempt {
  /** Aborted on shutdown, timeout or lease loss; what the handler and its middleware receive. */
  readonly signal: AbortSignal;
  readonly #shutdown: AbortSignal;
  readonly #controller = new AbortController();
  readonly #clock: JobsClock;
  readonly #graceMs: number;
  readonly #ledger: AttemptLedger;
  readonly #onShutdown: () => void;
  #timeoutTimer: LongTimer | undefined;
  #graceTimer: LongTimer | undefined;
  #onAbort: (() => void) | undefined;
  #cause: AbortCause | undefined;
  #abortError: Error | undefined;
  #disposed = false;

  constructor(options: AttemptOptions) {
    this.#shutdown = options.shutdown;
    this.#clock = options.clock;
    this.#graceMs = options.handlerGraceMs;
    this.#ledger = options.ledger;
    this.#onShutdown = () => {
      this.#cause ??= 'shutdown';
    };
    if (this.#shutdown.aborted) this.#cause = 'shutdown';
    else this.#shutdown.addEventListener('abort', this.#onShutdown, { once: true });
    this.signal = AbortSignal.any([this.#shutdown, this.#controller.signal]);
    if (options.timeoutMs === undefined) return;
    this.#timeoutTimer = setLongTimeout(
      () => {
        this.#timeoutTimer = undefined;
        this.#abortWith('timeout', new JobsErrors.Error('attempt_timeout'));
      },
      options.timeoutMs,
      this.#clock,
    );
  }

  /** Which source aborted first, or `undefined` while the signal has not aborted. */
  get cause(): AbortCause | undefined {
    return this.#cause;
  }

  /** The error the deadline or the lease loss aborted with, once one did. */
  get abortError(): Error | undefined {
    return this.#abortError;
  }

  /**
   * The attempt lost its overlap lease: abort with `jobs.overlap_lost`.
   * Idempotent, and a no-op once the signal aborted or the attempt was
   * disposed.
   */
  loseLease(): void {
    if (this.#disposed || this.signal.aborted) return;
    this.#abortWith('lease_lost', new JobsErrors.Error('overlap_lost'));
  }

  #abortWith(cause: AbortCause, error: Error): void {
    this.#abortError ??= error;
    this.#cause ??= cause;
    this.#controller.abort(error);
  }

  /**
   * Wait for `work`, the attempt's code. Resolves only once it settled; when
   * the signal aborts first, the grace starts and poisons the worker if the
   * code is still running when it ends.
   */
  async hold<T>(work: Promise<T>): Promise<Settled<T>> {
    const result: Promise<Settled<T>> = work.then(
      (value): Settled<T> => ({ ok: true, value }),
      (error: unknown): Settled<T> => ({ ok: false, error }),
    );
    if (!this.signal.aborted) {
      const aborted = new Promise<typeof ABORTED>((resolve) => {
        this.#onAbort = () => resolve(ABORTED);
        this.signal.addEventListener('abort', this.#onAbort, { once: true });
      });
      const first = await Promise.race([result, aborted]);
      if (first !== ABORTED) return first;
    }
    this.#graceTimer = setLongTimeout(
      () => {
        this.#graceTimer = undefined;
        this.#ledger.poison();
      },
      this.#graceMs,
      this.#clock,
    );
    return result;
  }

  /** Clear every timer and listener. Called once the attempt settled. */
  dispose(): void {
    this.#disposed = true;
    this.#timeoutTimer?.cancel();
    this.#timeoutTimer = undefined;
    this.#graceTimer?.cancel();
    this.#graceTimer = undefined;
    this.#shutdown.removeEventListener('abort', this.#onShutdown);
    if (this.#onAbort !== undefined) {
      this.signal.removeEventListener('abort', this.#onAbort);
      this.#onAbort = undefined;
    }
  }
}
