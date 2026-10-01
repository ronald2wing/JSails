/**
 * Overlap control middleware: prevent concurrent executions of the same
 * scheduled job by holding a lease from a {@link LeaseStore}. The overlap
 * descriptor is carried in dispatch options under {@link OVERLAP_OPTION_KEY}
 * and resolved by `prepareSchedules` in `./scheduler.js`.
 *
 * ## Model
 *
 * A scheduled job that opts into overlap control carries a resolved
 * `OverlapDescriptor` (`{ key, ttlMs }`) in its dispatch options. The
 * middleware, registered on the job via
 * `new JobsRuntimeImpl({ middleware: { [jobName]: [createOverlapMiddleware(leases)] } })`,
 * takes a lease on `descriptor.key` before running the handler (through
 * `withLease`, which renews it every `ttlMs / 3` and releases it with
 * compare-and-delete). If the key is held (the previous run is still in
 * flight), the middleware skips this invocation: it returns `undefined`
 * without calling the handler and without throwing.
 *
 * A skipped run is a normal outcome, not a failure. Throwing or returning
 * an error would trigger adapter retries and defeat overlap control:
 * the scheduler would retry the job, the lease would still be held (by the
 * previous run), and the retry cycle would repeat until the lease expires.
 *
 * ## Fail-safe discipline
 *
 * A malformed or absent descriptor is treated as a no-op: the middleware calls
 * `next()` and returns its result unchanged. A framework-internal descriptor
 * problem — a corrupt option value wired by the scheduler itself — must never
 * fail the job and trigger retries.
 *
 * ## Ownership and renewal
 *
 * A run longer than the TTL keeps its lease through renewal, and a run can
 * never release a lease that another run now holds. The TTL only bounds how
 * long a crashed worker's lease survives. An attempt whose `context.signal`
 * has aborted (it timed out, or the worker force-closed) settles while its
 * handler may still be running, so its lease is not released: renewal stops
 * and the lease expires after its TTL, which keeps the next tick from running
 * alongside the abandoned handler. A release failure is swallowed; the
 * handler's result or error always propagates unchanged.
 *
 * ## In-process limitation
 *
 * A `MemoryLeaseStore` excludes within a single process only. A deployment
 * with several worker processes uses a `ValkeyLeaseStore`, so every worker
 * sees the same leases.
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
 * import { MemoryLeaseStore } from '@jsails/cache';
 *
 * const runtime = new JobsRuntimeImpl({
 *   registry,
 *   adapter,
 *   middleware: {
 *     digest: [createOverlapMiddleware(new MemoryLeaseStore())],
 *   },
 * });
 * ```
 */

import { withLease, type LeaseStore } from '../cache/lease.js';
import { type JobMiddleware, type JobMiddlewareContext } from './middleware.js';
import { OVERLAP_OPTION_KEY } from './option-keys.js';
import { isOverlapDescriptor } from './scheduler.js';

const overlapMiddlewares = new WeakSet<JobMiddleware>();

/** Whether a middleware was created by {@link createOverlapMiddleware}. */
export function isOverlapMiddleware(middleware: JobMiddleware): boolean {
  return overlapMiddlewares.has(middleware);
}

/**
 * Build a per-job middleware that prevents overlapping runs with a lease on
 * the descriptor's key. Register it on every job that opts into overlap
 * control via
 * `new JobsRuntimeImpl({ middleware: { [jobName]: [createOverlapMiddleware(leases)] } })`.
 *
 * @param leases - The lease store. A single process can use
 *   `new MemoryLeaseStore()` (from `@jsails/cache`); several processes need
 *   `new ValkeyLeaseStore({ connections })` on shared Valkey connections.
 */
export function createOverlapMiddleware(leases: LeaseStore): JobMiddleware {
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

    const outcome = await withLease(
      leases,
      raw.key,
      { ttlMs: raw.ttlMs, ...(context.signal === undefined ? {} : { signal: context.signal }) },
      () => next(),
    );
    // A held key means the previous run is still in flight: skip without
    // throwing (see above).
    return outcome.acquired ? outcome.value : undefined;
  };
  overlapMiddlewares.add(middleware);
  return middleware;
}
