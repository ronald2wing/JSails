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
 * ## Recording
 *
 * Each index is recorded with one atomic `add` of its own key, holding an
 * empty string for a success or the `{ job, error }` JSON of a failure. Only
 * the first record of an index is stored, so recording is idempotent across
 * processes and concurrent workers never lose an update. Completion is read by
 * counting the recorded indices with `getMany`, coalesced so a burst of
 * records costs one count. A recorded index never changes, so the registering
 * process keeps the frontier below which every index is known recorded (and
 * the failures read there) and resumes each count from it: a count reads the
 * indices recorded since the last one, in chunks that start small and double,
 * so a batch of N items costs O(N) key reads however its records interleave.
 * Every key carries the batch TTL, so an abandoned batch decays on its own.
 *
 * The store is a cache: an entry evicted under memory pressure before a count
 * read it is a recorded index forgotten, and the batch then never settles.
 * Give batches a store with room for them. The jobs package replaces this
 * coordinator.
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
 * import { valkeyToken } from 'jsails/plugin-sdk';
 *
 * const cache = new ValkeyCacheStore({ connections: services.get(valkeyToken) });
 * const coordinator = new SharedBatchCoordinator(cache.namespace('batches'));
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
import { MAX_CACHE_TTL_MS, type CacheStore } from '../cache/store.js';
import { JsailsError } from '../errors/jsails-error.js';
import { summarizeJobError } from './events.js';
import { runWithoutTenant } from '../database/tenant-context.js';
import { detach, escalate } from '../support/detach.js';

const KEY_PREFIX = 'jsails:batch';

function keyFor(id: string): string {
  return `${KEY_PREFIX}:${id}`;
}

function indexKey(id: string, index: number): string {
  return `${keyFor(id)}:r:${String(index)}`;
}

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

const DEFAULT_TTL_MS = 3_600_000;

/** Default interval at which the registering process polls shared progress. */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Index keys read by a count's first `getMany`. Most counts follow one record
 * at the frontier, so the first read stays small; each later read of the same
 * count doubles, up to {@link COUNT_CHUNK}.
 */
const FIRST_COUNT_CHUNK = 64;

/** The most index keys read by one `getMany` while counting a batch. */
const COUNT_CHUNK = 1024;

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

/** In-process state; callbacks live here, not in the store. */
interface InProcessState {
  readonly total: number;
  readonly callbacks: BatchCallbacks;
  /** Guard so settlement fires at most once per process. */
  settled: boolean;
  /** Every index below this one is known recorded; the next count starts here. */
  frontier: number;
  /** The failures recorded below `frontier`, in index order. */
  readonly failures: BatchFailure[];
  /** A count is reading the store. */
  counting: boolean;
  /** A record arrived during that count, so it runs once more. */
  recount: boolean;
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

/** The default {@link SharedBatchErrorHandler}: class name and code only. */
function logBatchStoreFailure(error: unknown, operation: SharedBatchOperation): void {
  const summary = summarizeJobError(error);
  const code = summary.code === undefined ? '' : ` [${summary.code}]`;
  console.error(
    `[jsails:jobs] the shared batch coordinator could not ${operation} batch progress: ` +
      `${summary.name}${code}`,
  );
}

/** A recorded failure read back from its index key, or `undefined` for a success. */
function parseFailure(raw: unknown): BatchFailure | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as { job?: unknown; error?: unknown };
    return {
      job: typeof parsed.job === 'string' ? parsed.job : '',
      error: typeof parsed.error === 'string' ? parsed.error : '',
    };
  } catch {
    return { job: '', error: '' };
  }
}

/**
 * Shared-store batch coordinator backed by a {@link CacheStore}.
 *
 * @param cache  The backing store (a namespace of the app cache, typically).
 * @param options See {@link SharedBatchCoordinatorOptions}.
 */
export class SharedBatchCoordinator implements BatchCoordinator {
  readonly #cache: CacheStore;
  readonly #ttlMs: number;
  readonly #pollIntervalMs: number;
  readonly #onError: SharedBatchErrorHandler;
  readonly #inProcess = new Map<string, InProcessState>();

  constructor(cache: CacheStore, options?: SharedBatchCoordinatorOptions) {
    if (
      cache === undefined ||
      cache === null ||
      typeof cache !== 'object' ||
      typeof cache.add !== 'function' ||
      typeof cache.getMany !== 'function'
    ) {
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
    const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_CACHE_TTL_MS) {
      throw new TypeError('ttlMs must be a whole number of milliseconds up to one year');
    }
    if (options?.onError !== undefined && typeof options.onError !== 'function') {
      throw new TypeError('onError must be a function');
    }

    this.#cache = cache;
    this.#onError = options?.onError ?? logBatchStoreFailure;
    this.#ttlMs = ttlMs;
    this.#pollIntervalMs = pollIntervalMs;
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

  /** Fire settlement once. */
  #settle(id: string, ip: InProcessState, outcome: BatchOutcome): void {
    if (ip.settled || this.#inProcess.get(id) !== ip) return;
    ip.settled = true;
    if (ip.poll !== undefined) {
      clearInterval(ip.poll);
      ip.poll = undefined;
    }
    this.#runCallbacks(id, ip, outcome);
  }

  /**
   * Advance the frontier over the indices recorded since the last count: the
   * batch's outcome once every index is recorded, else `undefined`. Only
   * `#count` calls it, one at a time per batch, so the frontier never
   * moves under a read.
   */
  async #readOutcome(id: string, ip: InProcessState): Promise<BatchOutcome | undefined> {
    let size = FIRST_COUNT_CHUNK;
    while (ip.frontier < ip.total) {
      const keys: string[] = [];
      const end = Math.min(ip.total, ip.frontier + size);
      for (let index = ip.frontier; index < end; index += 1) keys.push(indexKey(id, index));
      const values = await this.#cache.getMany(keys);
      for (const value of values) {
        if (value === null) return undefined;
        const failure = parseFailure(value);
        if (failure !== undefined) ip.failures.push(failure);
        ip.frontier += 1;
      }
      size = Math.min(COUNT_CHUNK, size * 2);
    }
    const failed = ip.failures.length;
    return { succeeded: ip.total - failed, failed, failures: ip.failures };
  }

  /**
   * Count the batch and settle it when complete. One count runs per batch at a
   * time; a record that lands during it asks for one more, so a burst of
   * records costs one read of the store, not one each.
   */
  async #count(id: string): Promise<void> {
    const ip = this.#inProcess.get(id);
    if (ip === undefined || ip.settled) return;
    if (ip.counting) {
      ip.recount = true;
      return;
    }
    ip.counting = true;
    try {
      do {
        ip.recount = false;
        const outcome = await this.#readOutcome(id, ip);
        if (outcome !== undefined) {
          this.#settle(id, ip, outcome);
          return;
        }
      } while (ip.recount && !ip.settled);
    } finally {
      ip.counting = false;
    }
  }

  #startPoll(id: string, ip: InProcessState): void {
    if (this.#pollIntervalMs === 0 || ip.poll !== undefined) return;
    // The poll reads shared progress with no ambient tenant.
    const poll = setInterval(() => {
      detach(
        runWithoutTenant(() =>
          this.#count(id).catch(() => {
            // A transient store failure is retried on the next poll.
          }),
        ),
        escalate,
      );
    }, this.#pollIntervalMs);
    // Polling is a notification aid; it must never keep the process alive.
    poll.unref();
    ip.poll = poll;
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
    const ip: InProcessState = {
      total,
      callbacks,
      settled: false,
      frontier: 0,
      failures: [],
      counting: false,
      recount: false,
      poll: undefined,
      expiry,
    };
    this.#inProcess.set(id, ip);
    this.#startPoll(id, ip);

    // Awaited, so a batch whose progress could not be persisted is never
    // dispatched (`createJobBatch` awaits this before sending any job): its
    // records would find no batch and it would never settle.
    try {
      await this.#cache.set(keyFor(id), JSON.stringify({ id, total }), this.#ttlMs);
    } catch (error) {
      this.#forget(id);
      throw error;
    }
  }

  record(id: string, job: string, index: number, errorMessage: string | undefined): void {
    // A transient store failure leaves the index unrecorded, so a redelivered
    // attempt can record it again; the TTL handles orphans.
    this.#record(id, job, index, errorMessage).catch((error: unknown) =>
      this.#report(error, 'record'),
    );
  }

  async #record(
    id: string,
    job: string,
    index: number,
    errorMessage: string | undefined,
  ): Promise<void> {
    // An expired or removed batch is not resurrected by a late record.
    if ((await this.#cache.get(keyFor(id))) === null) return;
    const payload =
      errorMessage === undefined
        ? ''
        : JSON.stringify({ job, error: errorMessage } satisfies BatchFailure);
    if (!(await this.#cache.add(indexKey(id, index), payload, this.#ttlMs))) return;
    // Only the registering process holds callbacks; elsewhere this is a no-op.
    await this.#count(id);
  }

  remove(id: string): void {
    this.#forget(id);
    // The index keys are left to their TTL: their count is known only here,
    // and no record reads them once the batch key is gone.
    Promise.resolve()
      .then(() => this.#cache.delete(keyFor(id)))
      .catch((error: unknown) => this.#report(error, 'remove'));
  }
}
