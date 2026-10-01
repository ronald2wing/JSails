/**
 * Overlap control middleware: prevent concurrent executions of the same
 * scheduled job using a {@link MutexStore}. The overlap descriptor is carried
 * in dispatch options under {@link OVERLAP_OPTION_KEY} and resolved by
 * `prepareSchedules` in `./scheduler.js`.
 *
 * ## Model
 *
 * A scheduled job that opts into overlap control carries a resolved
 * `OverlapDescriptor` (`{ key, ttlMs }`) in its dispatch options. The
 * middleware, registered on the job via
 * `new JobsRuntimeImpl({ middleware: { [jobName]: [createOverlapMiddleware(mutex)] } })`,
 * acquires a mutex for `descriptor.key` before running the handler and releases
 * it after. If the mutex is already held (the previous run is still in flight),
 * the middleware skips this invocation — it returns `undefined` without calling
 * the handler and without throwing.
 *
 * A skipped run is a normal outcome, not a failure. Throwing or returning
 * an error would trigger adapter retries and defeat overlap control:
 * the scheduler would retry the job, the mutex would still be held (by the
 * previous run), and the retry cycle would repeat until the lock expires.
 *
 * ## Fail-safe discipline
 *
 * A malformed or absent descriptor is treated as a no-op: the middleware calls
 * `next()` and returns its result unchanged. A framework-internal descriptor
 * problem — a corrupt option value wired by the scheduler itself — must never
 * fail the job and trigger retries. The handler result propagates as if the
 * middleware were not present.
 *
 * ## Ownership and renewal
 *
 * When the store implements the lease methods (`acquireLease`/`renewLease`/
 * `releaseLease`), the lock carries an owner token: it is renewed every
 * `ttlMs / 3` while the handler runs, so a run longer than the TTL keeps its
 * lock, and it is released with compare-and-delete, so a run can never delete
 * a lock that another run now holds. The TTL then only bounds how long a
 * crashed worker's lock survives.
 *
 * A store without leases gets a plain `acquire`/`release` and no renewal: a
 * run that outlives its TTL may overlap the next one. To keep such a run from
 * also deleting the next run's lock, it skips `release` once its TTL has
 * elapsed and lets the entry expire instead.
 *
 * An attempt whose `context.signal` has aborted (it timed out, or the worker
 * force-closed) settles while its handler may still be running, so neither
 * path releases its lock then: renewal stops and the entry expires after its
 * TTL, which keeps the next tick from running alongside the abandoned handler.
 *
 * ## Release safety
 *
 * Release failures are swallowed. A release failure (e.g. the lock already
 * expired via TTL, or the backend is unreachable) must not corrupt the job
 * outcome: the handler result or error always propagates unchanged. The TTL
 * acts as a safety net — the key expires automatically and the next scheduled
 * tick can acquire it.
 *
 * ## In-process limitation
 *
 * A `MemoryMutexStore` guarantees mutual exclusion within a single
 * process only. In a multi-process deployment (separate worker processes), use
 * `ValkeyMutexStore` (shared backend) so all workers see the same lock
 * state. The middleware itself is store-agnostic — it calls `acquire`/`release`
 * on whatever `MutexStore` is injected.
 *
 * ## Option allowlist
 *
 * {@link OVERLAP_OPTION_KEY} is added to `ALLOWED_JOB_OPTIONS` in
 * `./queue.js` so the descriptor survives the `validateJobOptions` round-trip.
 * The trust model is the same as `CHAIN_OPTION_KEY` / `BATCH_OPTION_KEY`: a
 * caller who can dispatch can already dispatch any registered job with any
 * valid payload; the descriptor grants no new capability.
 *
 * ## Wiring
 *
 * ```ts
 * import { JobsRuntimeImpl } from 'jsails';
 * import { createOverlapMiddleware } from 'jsails/jobs';
 * import { MemoryMutexStore } from '@jsails/cache';
 *
 * const mutex = new MemoryMutexStore();
 * const runtime = new JobsRuntimeImpl({
 *   registry,
 *   adapter,
 *   middleware: {
 *     digest: [createOverlapMiddleware(mutex)],
 *   },
 * });
 * ```
 */

import { supportsLeases, type LeaseMutexStore, type MutexStore } from '../cache/mutex.js';
import { type JobMiddleware, type JobMiddlewareContext } from './middleware.js';
import { isOverlapDescriptor } from './scheduler.js';

/** Reserved dispatch-option key carrying the resolved overlap descriptor. */
export const OVERLAP_OPTION_KEY = '__jsailsOverlap';

/**
 * Build a per-job middleware that prevents overlapping runs using a mutex.
 * The overlap descriptor rides in the scheduled job's options under
 * {@link OVERLAP_OPTION_KEY}.
 *
 * Register it on every job that opts into overlap control via
 * `new JobsRuntimeImpl({ middleware: { [jobName]: [createOverlapMiddleware(mutex)] } })`.
 *
 * @param mutex - The mutex store backing acquire/release. For single-process
 *   deployments use `new MemoryMutexStore()` (from `@jsails/cache`); for
 *   multi-process deployments use `new ValkeyMutexStore({ valkeyUrl })`.
 */
const overlapMiddlewares = new WeakSet<JobMiddleware>();

/** Whether a middleware was created by {@link createOverlapMiddleware}. */
export function isOverlapMiddleware(middleware: JobMiddleware): boolean {
  return overlapMiddlewares.has(middleware);
}

export function createOverlapMiddleware(mutex: MutexStore): JobMiddleware {
  const middleware: JobMiddleware = async (
    _data: unknown,
    context: JobMiddlewareContext,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const options = (context.options as Record<string, unknown>) ?? {};
    const raw = options[OVERLAP_OPTION_KEY];

    // Fail safe: no descriptor or a malformed one means the scheduler did not
    // opt this job into overlap control (or the descriptor was corrupted).
    // A framework-internal descriptor problem must not fail the job and trigger
    // retries — the handler result propagates unchanged.
    if (raw === undefined || !isOverlapDescriptor(raw)) {
      return next();
    }

    const descriptor = raw;

    if (supportsLeases(mutex)) {
      return runWithLease(mutex, descriptor.key, descriptor.ttlMs, next, context.signal);
    }

    const acquired = await mutex.acquire(descriptor.key, descriptor.ttlMs);

    if (!acquired) {
      // The previous run is still in flight. Skip this invocation without
      // calling the handler and without throwing — a skipped run is a normal
      // outcome, not a failure. Throwing would trigger adapter retries, which
      // would re-enter this check and skip again, defeating overlap control.
      return undefined;
    }

    // Acquired: run the handler. Release the mutex in finally so a handler
    // failure does not hold the lock until TTL.
    const acquiredAt = Date.now();
    try {
      return await next();
    } finally {
      // Without an owner token the store cannot tell whose entry it deletes:
      // past the TTL the key may already belong to the next run, so it is left
      // to expire rather than released. An aborted attempt is left to expire
      // too, because its handler may still be running.
      if (context.signal?.aborted !== true && Date.now() - acquiredAt < descriptor.ttlMs) {
        try {
          await mutex.release(descriptor.key);
        } catch {
          // Swallowed: a release failure is a cleanup issue, not a job failure.
        }
      }
    }
  };
  overlapMiddlewares.add(middleware);
  return middleware;
}

/**
 * Hold an owner-token lease for the handler's whole run: renew it every
 * `ttlMs / 3` and release it with compare-and-delete, so the lock neither
 * expires under a long run nor is released on another holder's behalf.
 */
async function runWithLease(
  mutex: LeaseMutexStore,
  key: string,
  ttlMs: number,
  next: () => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const token = await mutex.acquireLease(key, ttlMs);
  if (token === undefined) {
    // The previous run is still in flight: skip without throwing (see above).
    return undefined;
  }
  const renewal = setInterval(
    () => {
      // A failed renewal is retried on the next tick; if the lease is truly
      // lost, the compare-and-delete release below leaves the new holder alone.
      void mutex.renewLease(key, token, ttlMs).catch(() => false);
    },
    Math.max(1, Math.floor(ttlMs / 3)),
  );
  // Renewal must never keep a draining worker process alive on its own.
  renewal.unref();
  try {
    return await next();
  } finally {
    clearInterval(renewal);
    // An aborted attempt (timeout, forced close) settles while its handler may
    // still be running: the runtime stops awaiting it, it does not stop it.
    // Releasing then would let the next tick run alongside that handler, so
    // the lease is left to expire after its TTL instead.
    if (signal?.aborted !== true) {
      try {
        await mutex.releaseLease(key, token);
      } catch {
        // Swallowed: a release failure is a cleanup issue, not a job failure.
      }
    }
  }
}
