/**
 * Shared-store batch coordinator: a {@link BatchCoordinator} backed by a
 * {@link CacheStore} so producer and worker processes can share batch progress
 * through a common store (e.g. Valkey).
 *
 * ## Model
 *
 * `register` persists the batch under the deterministic key `jsails:batch:<id>`
 * with a configurable TTL (default 1 hour). Callbacks live **in-process** in
 * the registering process, which settles the batch either when one of its own
 * `record` calls completes it or when its poll (every `pollIntervalMs`,
 * default 1 s) sees every index recorded — so a web process that dispatches a
 * batch still fires its callbacks when separate worker processes do all the
 * work.
 *
 * ## Atomic recording (stores with `increment`)
 *
 * When the store implements the atomic `increment` (both `@jsails/cache`
 * stores do), every write is a single atomic operation and the I/O per record
 * is constant:
 *
 * - a per-index claim counter makes recording idempotent across processes
 *   (only the first claim of an index counts);
 * - a failure writes its `{ job, error }` under a per-index key, then bumps a
 *   failed counter;
 * - a recorded counter reaches `total` exactly once, after every failure entry
 *   is written.
 *
 * Concurrent workers therefore never lose an update. Every key carries the
 * batch TTL, so an abandoned batch decays on its own.
 *
 * ## Fallback (stores without `increment`)
 *
 * A store without `increment` gets a read-modify-write of one JSON document.
 * Within a process the writes are serialized, but across processes the last
 * writer wins and a concurrently recorded index can be lost; use a store with
 * `increment` for multi-process batches.
 *
 * ## Store failures
 *
 * `register` resolves once the batch is persisted and rejects when the store
 * write fails, so `createJobBatch(...).dispatch()` refuses to send jobs whose
 * progress could never be recorded. Every other write runs in the background
 * (the contract's `record` and `remove` are synchronous); a failed one is
 * passed to `onError`, which by default logs a value-free line, and never
 * becomes an unhandled rejection that would end the process.
 *
 * ## Wiring
 *
 * ```ts
 * import { SharedBatchCoordinator } from 'jsails/jobs';
 * import { ValkeyCacheStore } from '@jsails/cache';
 *
 * const cache = new ValkeyCacheStore({ valkeyUrl: 'redis://...' });
 * const coordinator = new SharedBatchCoordinator(cache);
 * // Use this coordinator with createJobBatch + createBatchMiddleware.
 * ```
 */

import type {
  BatchCallbacks,
  BatchCoordinator,
  BatchFailure,
  BatchFailedSummary,
  BatchSummary,
} from './batch.js';
import type { CacheStore } from '../cache/store.js';
import { mapConcurrent } from '../support/async.js';
import { JsailsError } from '../errors/jsails-error.js';
import { summarizeJobError } from './events.js';
import { runWithoutTenant } from '../database/tenant-context.js';
import { detach, escalate } from '../support/detach.js';

// ---------------------------------------------------------------------------
// Key namespace
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'jsails:batch';

function keyFor(id: string): string {
  return `${KEY_PREFIX}:${id}`;
}

// ---------------------------------------------------------------------------
// Serialized state
// ---------------------------------------------------------------------------

interface SerializedState {
  id: string;
  total: number;
  recorded: number[];
  succeeded: number;
  failed: number;
  failures: Array<{ job: string; error: string }>;
}

// ---------------------------------------------------------------------------
// In-process state (callbacks live here, not in the cache)
// ---------------------------------------------------------------------------

interface InProcessState {
  readonly total: number;
  readonly callbacks: BatchCallbacks;
  /** Guard so settlement fires at most once per process. */
  settled: boolean;
  /** Polls the shared progress so work recorded elsewhere still settles. */
  poll: ReturnType<typeof setInterval> | undefined;
  /** Drops the entry once the persisted state has expired. */
  expiry: ReturnType<typeof setTimeout>;
}

/** What a settled batch reports to its callbacks. */
interface BatchOutcome {
  readonly succeeded: number;
  readonly failed: number;
  readonly failures: readonly BatchFailure[];
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Stable failure code carried by {@link SharedBatchCoordinatorError}. */
export type SharedBatchCoordinatorErrorCode = 'invalid_cache';

/** Raised for an invalid shared-batch-coordinator call. Messages are value-free. */
export class SharedBatchCoordinatorError extends JsailsError {
  constructor(
    readonly code: SharedBatchCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Default TTL (1 hour)
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 3_600_000;

/** Default interval at which the registering process polls shared progress. */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Failure entries read at once when a counter-mode batch settles. */
const FAILURE_READ_CONCURRENCY = 32;

/** A background store write that can fail without a caller to report to. */
export type SharedBatchOperation = 'record' | 'remove';

/** Receives a failed background store write; see {@link SharedBatchCoordinatorOptions}. */
export type SharedBatchErrorHandler = (error: unknown, operation: SharedBatchOperation) => void;

/** Options for {@link SharedBatchCoordinator}. */
export interface SharedBatchCoordinatorOptions {
  /** TTL of every persisted key and of the in-process callback entry. Default 1 hour. */
  readonly ttlMs?: number;
  /** How often the registering process polls shared progress; `0` disables. Default 1000. */
  readonly pollIntervalMs?: number;
  /**
   * Called when a background store write fails. Defaults to one value-free
   * `console.error` line, the jobs runtime's own reporting channel.
   */
  readonly onError?: SharedBatchErrorHandler;
}

/** The default {@link SharedBatchErrorHandler}: class name and code only. */
function logBatchStoreFailure(error: unknown, operation: SharedBatchOperation): void {
  const summary = summarizeJobError(error);
  const code = summary.code === undefined ? '' : ` [${summary.code}]`;
  console.error(
    `[jsails:jobs] the shared batch coordinator could not ${operation} batch progress: ` +
      `${summary.name}${code}`,
  );
}

/** Parse a counter value read back through `get`; absent means zero. */
function parseCounter(raw: string | null): number {
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Implementation (private #fields)
// ---------------------------------------------------------------------------

/**
 * Shared-store batch coordinator backed by a {@link CacheStore}.
 *
 * @param cache  The backing cache. Its `set` must accept a `ttlMs` argument;
 *               implementations that ignore it will never auto-evict orphans.
 *               A cache with `increment` gets atomic, constant-cost recording.
 * @param options See {@link SharedBatchCoordinatorOptions}.
 */
export class SharedBatchCoordinator implements BatchCoordinator {
  readonly #cache: CacheStore;
  readonly #ttlMs: number;
  readonly #pollIntervalMs: number;
  readonly #increment: ((key: string, ttlMs: number) => Promise<number>) | undefined;
  readonly #atomic: boolean;
  readonly #onError: SharedBatchErrorHandler;
  readonly #inProcess = new Map<string, InProcessState>();
  // Serializes each batch's read-modify-write in fallback mode so sequential
  // same-tick `record` calls on one batch apply in order (the contract's
  // `record` is synchronous, but cache I/O is async). An entry is dropped as
  // soon as its chain drains.
  readonly #writeChains = new Map<string, Promise<unknown>>();

  constructor(cache: CacheStore, options?: SharedBatchCoordinatorOptions) {
    if (cache === undefined || cache === null || typeof cache !== 'object') {
      throw new SharedBatchCoordinatorError(
        'invalid_cache',
        'shared batch coordinator requires a cache store',
      );
    }
    if (
      options !== undefined &&
      (options === null || typeof options !== 'object' || Array.isArray(options))
    ) {
      throw new TypeError('options must be an object');
    }
    const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
      throw new TypeError('pollIntervalMs must be a non-negative integer');
    }

    if (options?.onError !== undefined && typeof options.onError !== 'function') {
      throw new TypeError('onError must be a function');
    }

    this.#cache = cache;
    this.#onError = options?.onError ?? logBatchStoreFailure;
    this.#ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.#pollIntervalMs = pollIntervalMs;
    this.#increment = cache.increment?.bind(cache);
    this.#atomic = this.#increment !== undefined;
  }

  #runCallbacks(batchId: string, ip: InProcessState, outcome: BatchOutcome): void {
    const { callbacks } = ip;
    // Callbacks run with no ambient tenant, whether a job's record or the poll
    // settled the batch.
    detach(
      runWithoutTenant(async () => {
        try {
          const summary: BatchSummary = {
            id: batchId,
            total: ip.total,
            succeeded: outcome.succeeded,
            failed: outcome.failed,
          };

          if (outcome.failed === 0) {
            if (callbacks.then) {
              try {
                await callbacks.then(summary);
              } catch {
                // Swallowed: notification failure must not affect any job.
              }
            }
          } else {
            if (callbacks.catch) {
              try {
                await callbacks.catch({
                  ...summary,
                  failures: [...outcome.failures],
                } satisfies BatchFailedSummary);
              } catch {
                // Swallowed.
              }
            }
          }

          if (callbacks.finally) {
            try {
              await callbacks.finally(summary);
            } catch {
              // Swallowed.
            }
          }
        } finally {
          this.#forget(batchId);
        }
      }),
      escalate,
    );
  }

  /** Drop the in-process entry and stop its timers. */
  #forget(id: string): void {
    const ip = this.#inProcess.get(id);
    if (ip === undefined) return;
    if (ip.poll !== undefined) clearInterval(ip.poll);
    clearTimeout(ip.expiry);
    this.#inProcess.delete(id);
  }

  /** Fire settlement once, with `outcome` or the outcome read from the store. */
  async #settle(id: string, outcome?: BatchOutcome): Promise<void> {
    const ip = this.#inProcess.get(id);
    if (ip === undefined || ip.settled) return;
    ip.settled = true;
    if (ip.poll !== undefined) {
      clearInterval(ip.poll);
      ip.poll = undefined;
    }
    try {
      this.#runCallbacks(id, ip, outcome ?? (await this.#readCounterOutcome(id, ip.total)));
    } catch {
      // The store could not be read: keep the entry so the poll can retry.
      ip.settled = false;
      this.#startPoll(id, ip);
    }
  }

  /** Read a counter-mode batch's outcome, including every failure entry. */
  async #readCounterOutcome(id: string, total: number): Promise<BatchOutcome> {
    const key = keyFor(id);
    const failed = parseCounter(await this.#cache.get(`${key}:failed`));
    let failures: BatchFailure[] = [];
    if (failed > 0) {
      const indices = Array.from({ length: total }, (_unused, index) => index);
      const entries = await mapConcurrent(
        indices,
        (index) => this.#cache.get(`${key}:f:${index}`),
        { concurrency: FAILURE_READ_CONCURRENCY },
      );
      failures = entries.flatMap((raw) => {
        if (raw === null) return [];
        const parsed = JSON.parse(raw) as { job: string; error: string };
        return [{ job: parsed.job, error: parsed.error } satisfies BatchFailure];
      });
    }
    return { succeeded: total - failed, failed, failures };
  }

  /** Whether every index has been recorded, according to the store. */
  async #isComplete(id: string, total: number): Promise<boolean> {
    if (this.#atomic) {
      return parseCounter(await this.#cache.get(`${keyFor(id)}:n`)) >= total;
    }
    const raw = await this.#cache.get(keyFor(id));
    if (raw === null) return false;
    return (JSON.parse(raw) as SerializedState).recorded.length >= total;
  }

  #startPoll(id: string, ip: InProcessState): void {
    if (this.#pollIntervalMs === 0 || ip.poll !== undefined) return;
    // The poll is started lazily from whichever context registered or recorded
    // first; it reads shared progress with no ambient tenant.
    const poll = setInterval(() => {
      detach(
        runWithoutTenant(() => this.#pollOnce(id)),
        escalate,
      );
    }, this.#pollIntervalMs);
    // Polling is a notification aid; it must never keep the process alive.
    poll.unref();
    ip.poll = poll;
  }

  async #pollOnce(id: string): Promise<void> {
    const ip = this.#inProcess.get(id);
    if (ip === undefined || ip.settled) return;
    try {
      if (!(await this.#isComplete(id, ip.total))) return;
      if (this.#atomic) {
        await this.#settle(id);
        return;
      }
      const raw = await this.#cache.get(keyFor(id));
      if (raw === null) return;
      const state = JSON.parse(raw) as SerializedState;
      await this.#settle(id, state);
    } catch {
      // A transient store failure is retried on the next poll.
    }
  }

  /** Report a failed background write; a throwing handler must not escape either. */
  #report(error: unknown, operation: SharedBatchOperation): void {
    try {
      this.#onError(error, operation);
    } catch {
      // The handler is the last stop: rethrowing would be the unhandled
      // rejection it exists to prevent.
    }
  }

  async register(id: string, total: number, callbacks: BatchCallbacks): Promise<void> {
    const expiry = setTimeout(() => this.#forget(id), this.#ttlMs);
    // Expiry is housekeeping; it must never keep the process alive.
    expiry.unref();
    const ip: InProcessState = { total, callbacks, settled: false, poll: undefined, expiry };
    this.#inProcess.set(id, ip);
    this.#startPoll(id, ip);

    const serialized: SerializedState = {
      id,
      total,
      recorded: [],
      succeeded: 0,
      failed: 0,
      failures: [],
    };
    // Awaited, so a batch whose progress could not be persisted is never
    // dispatched (`createJobBatch` awaits this before sending any job): its
    // records would find no batch and it would never settle.
    try {
      await this.#cache.set(keyFor(id), JSON.stringify(serialized), this.#ttlMs);
    } catch (error) {
      this.#forget(id);
      throw error;
    }
  }

  record(id: string, job: string, index: number, errorMessage: string | undefined): void {
    if (this.#atomic) {
      // A transient store failure leaves the claim unmade, so a redelivered
      // attempt can record the index again; the TTL handles orphans.
      this.#recordAtomic(id, job, index, errorMessage).catch((error: unknown) =>
        this.#report(error, 'record'),
      );
      return;
    }
    this.#recordFallback(id, job, index, errorMessage);
  }

  async #recordAtomic(
    id: string,
    job: string,
    index: number,
    errorMessage: string | undefined,
  ): Promise<void> {
    const key = keyFor(id);
    const increment = this.#increment;
    if (increment === undefined) return;
    // An expired or removed batch is not resurrected by a late record.
    if ((await this.#cache.get(key)) === null) return;
    if ((await increment(`${key}:i:${index}`, this.#ttlMs)) !== 1) return;
    if (errorMessage !== undefined) {
      await this.#cache.set(
        `${key}:f:${index}`,
        JSON.stringify({ job, error: errorMessage } satisfies BatchFailure),
        this.#ttlMs,
      );
      await increment(`${key}:failed`, this.#ttlMs);
    }
    const recorded = await increment(`${key}:n`, this.#ttlMs);
    const ip = this.#inProcess.get(id);
    if (ip !== undefined && recorded >= ip.total) {
      await this.#settle(id);
    }
  }

  #recordFallback(id: string, job: string, index: number, errorMessage: string | undefined): void {
    const cache = this.#cache;
    const ttlMs = this.#ttlMs;
    const writeChains = this.#writeChains;

    // Chain each batch's read-modify-write onto the previous write so
    // sequential same-tick records never read a stale snapshot. Cross-process
    // racing is last-writer-wins (documented); within THIS process ordering is
    // deterministic.
    const previous = writeChains.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        const raw = await cache.get(keyFor(id));
        if (raw === null) {
          return; // entry expired or never persisted
        }

        const parsed = JSON.parse(raw) as SerializedState;

        // Idempotent per index — skip duplicates.
        if (parsed.recorded.includes(index)) {
          return;
        }
        parsed.recorded.push(index);

        if (errorMessage === undefined) {
          parsed.succeeded += 1;
        } else {
          parsed.failed += 1;
          parsed.failures.push({ job, error: errorMessage } satisfies BatchFailure);
        }

        await cache.set(keyFor(id), JSON.stringify(parsed), ttlMs);

        if (parsed.recorded.length >= parsed.total) {
          // Only the registering process holds callbacks; elsewhere this is a no-op.
          await this.#settle(id, parsed);
        }
      } catch (error) {
        // A transient failure leaves the entry intact; a later retry
        // (idempotent per index) will succeed. The TTL handles orphans.
        this.#report(error, 'record');
      }
    });
    writeChains.set(id, next);
    detach(
      next.then(() => {
        if (writeChains.get(id) === next) {
          writeChains.delete(id);
        }
      }),
      escalate,
    );
  }

  remove(id: string): void {
    this.#forget(id);
    this.#writeChains.delete(id);
    const key = keyFor(id);
    const keys = this.#atomic ? [key, `${key}:n`, `${key}:failed`] : [key];
    for (const target of keys) {
      // A failed delete only leaves a key for its TTL to expire.
      Promise.resolve()
        .then(() => this.#cache.delete(target))
        .catch((error: unknown) => this.#report(error, 'remove'));
    }
  }
}
