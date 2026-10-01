/**
 * The processor: one delivery in, one attempt outcome out. It is total: every
 * step is guarded and its promise never rejects, so an adapter maps outcomes
 * to its own operations without interpreting exceptions.
 *
 * One attempt runs in a fixed order:
 *
 * 1. decode the stored envelope; a malformed one fails for good, a newer
 *    version is released for a newer worker (`unknown_job`);
 * 2. look the job up in this worker's catalog; an unknown name is released
 *    the same way, so a worker of an older release leaves a newer release's
 *    job for a worker that knows it. So is a chain step whose next step or
 *    catch names a queue this worker does not declare, before anything runs:
 *    its settle could not enqueue them. Releases back off from 500 ms,
 *    doubling to 60 s, and the eleventh delivery fails with
 *    `jobs.unknown_job` (or `jobs.unknown_queue`): ten releases outlast a
 *    rolling deploy's window of mixed workers;
 * 3. restore the execution context the dispatch carried (a newer carrier
 *    version is deploy skew and released like a newer envelope; a malformed
 *    one fails for good);
 * 4. take the job's overlap lease when it has one: a key another run holds
 *    is a `skipped` outcome, a lease store that cannot be reached fails the
 *    attempt retryably, and an adapter without leases fails it for good;
 * 5. inside that context, under one abort race, deadline and hold: parse the
 *    payload with the worker's schema (a refusal fails for good), then run
 *    the definition's middleware, outermost first, and the handler. A lost
 *    lease aborts the signal as a timeout does;
 * 6. release the lease, then act on the flow: a completed or discarded chain
 *    step (or a skipped one whose definition says `onSkip: 'continue'`)
 *    carries the next step as a follow-up, and a final failure carries the
 *    chain's catch (unless it already fired) and the job's
 *    `onFinalFailure: 'drop'`. The processor enqueues nothing itself: the
 *    adapter stores the follow-ups in the operation that settles the job, so
 *    a step whose handler completed is never failed over its follow-up, and
 *    a catch is never lost to a transport error.
 *
 * The batch finalizer (`jsails.batch`) is resolved before the catalog: every
 * worker runs it, and it runs no user code.
 *
 * Restoring before parsing lets an async refinement run in the handler's
 * tenant and request context, and puts a refinement that hangs under the same
 * deadline, grace and poison rule as the handler.
 *
 * A failure is summarized value-free and classified by its kind's retry
 * column; the definition's `onError` sees the thrown value (or the timeout
 * error) and may discard it. A handler that resolves after its signal
 * aborted is `completed`: the effect happened. A rejection after a shutdown
 * abort is `released`, whatever it rejected with.
 */

import {
  ContextErrors,
  createExecutionContext,
  restoreContext,
  runInContext,
  type ExecutionContext,
} from 'jsails/context';

import {
  isFinalFailure,
  type AttemptOutcome,
  type JobEnvelope,
  type JobEnvelopeMeta,
  type JobErrorSummary,
  type JobsAdapter,
  type ProcessJob,
  type TransportJob,
} from '../contract/index.js';
import type { JobCatalog } from '../definition/catalog.js';
import {
  jobSpec,
  type JobContext,
  type JobErrorHandler,
  type JobFlowPosition,
  type JobMeta,
  type JobMiddleware,
  type JobSpec,
} from '../definition/define-job.js';
import type { Jobs } from '../definition/jobs-service.js';
import { decodeEnvelope } from '../envelope/codec.js';
import { runtimeSummary, summarizeJobError } from '../errors/error-summary.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { BATCH_FINALIZER_JOB, runBatchFinalizer } from '../flows/batch-finalizer.js';
import { chainAdvance, chainCatch, chainQueuesDeclared } from '../flows/chain-advance.js';
import { acquireOverlapLease, type OverlapLease } from '../overlap/overlap-lease.js';
import type { JobsClock } from '../timing/long-timer.js';
import { Attempt, type AttemptLedger } from './attempt.js';

/** Unknown-job releases before the job fails with `jobs.unknown_job`. */
export const MAX_UNKNOWN_RELEASES = 10;
/** The first unknown-job release delay; each further one doubles it. */
export const UNKNOWN_RELEASE_BASE_MS = 500;
/** The longest unknown-job release delay. */
export const UNKNOWN_RELEASE_MAX_MS = 60_000;

/** The delay of the release that follows `releases` earlier unknown-job releases. */
export function unknownReleaseDelay(releases: number): number {
  return Math.min(UNKNOWN_RELEASE_BASE_MS * 2 ** releases, UNKNOWN_RELEASE_MAX_MS);
}

/** What a processor is built from. */
export interface ProcessorOptions {
  readonly catalog: JobCatalog;
  /** The dispatcher handlers receive. */
  readonly jobs: Jobs;
  /** The leases overlap control takes and the batch status the finalizer reads. */
  readonly transport: Pick<JobsAdapter, 'capabilities'>;
  /** The runtime's timers and the `dispatchedAt` of follow-ups, never the adapter's clock. */
  readonly clock: JobsClock;
  readonly handlerGraceMs: number;
  readonly storeErrorMessages: boolean;
  readonly ledger: AttemptLedger;
}

type StageResult = 'done' | 'invalid_payload';

const RELEASED_SHUTDOWN: AttemptOutcome = Object.freeze({ kind: 'released', reason: 'shutdown' });
const COMPLETED: AttemptOutcome = Object.freeze({ kind: 'completed' });
const SKIPPED: AttemptOutcome = Object.freeze({ kind: 'skipped', reason: 'overlap' });

function failed(error: JobErrorSummary, retryable: boolean): AttemptOutcome {
  return Object.freeze({ kind: 'failed', error, retryable });
}

/**
 * Leave a job this worker's release cannot handle to a newer worker, or fail
 * it for good with `code` once it was released {@link MAX_UNKNOWN_RELEASES}
 * times.
 */
function unknownRelease(
  job: TransportJob,
  code: 'unknown_job' | 'unknown_queue' = 'unknown_job',
): AttemptOutcome {
  return job.unknownReleases >= MAX_UNKNOWN_RELEASES
    ? failed(runtimeSummary(code), false)
    : Object.freeze({
        kind: 'released',
        reason: 'unknown_job',
        delayMs: unknownReleaseDelay(job.unknownReleases),
      });
}

/** Where a job sits in its flow, without the stored steps of other jobs. */
function flowPosition(flow: NonNullable<JobEnvelopeMeta['flow']>): JobFlowPosition {
  return Object.freeze(
    flow.kind === 'chain'
      ? { kind: 'chain', id: flow.id, step: flow.step, remaining: flow.next.length }
      : flow,
  );
}

/** The envelope meta a handler reads: frozen, without the context carrier, the flow as a position. */
function handlerMeta(meta: JobEnvelopeMeta): JobMeta {
  const { context: _context, flow, ...rest } = meta;
  return Object.freeze({ ...rest, ...(flow === undefined ? {} : { flow: flowPosition(flow) }) });
}

type NextMisuse = 'middleware_next_reused' | 'middleware_next_late';

type StepResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

const STEP_OK: StepResult = Object.freeze({ ok: true });

function settle(work: Promise<void>): Promise<StepResult> {
  return work.then(
    () => STEP_OK,
    (error: unknown): StepResult => ({ ok: false, error }),
  );
}

/**
 * The rejection a refused `next()` returns. The chain records the misuse and
 * fails the attempt itself, so a middleware that drops this promise must not
 * also crash the process with an unhandled rejection.
 */
function refusedNext(code: NextMisuse): Promise<void> {
  const refusal = Promise.reject(new JobsErrors.Error(code));
  refusal.catch(() => {
    // Handled on purpose: the misuse already fails the attempt (see runChain).
  });
  return refusal;
}

/**
 * Run the middleware, outermost first, then the handler, with three rules
 * that keep the whole chain inside the attempt's hold:
 *
 * - A step settles only once the part of the chain its `next()` started has
 *   settled, so a middleware that neither awaits nor returns `next()` cannot
 *   release the job (its slot, its lock, its timeout and grace) while the
 *   handler still runs.
 * - A failure further in never gets lost: when a middleware resolves but
 *   what its `next()` ran failed, the step fails with that error. A
 *   middleware may replace the error by throwing its own; ending a job on a
 *   failure without a retry is the definition's `onError`.
 * - `next()` runs the rest of the chain once, and only while its middleware
 *   has not settled. A second call, or one after the middleware settled
 *   (from a timer, say), runs nothing and fails the attempt if it still
 *   runs: a handler run twice, or outside the hold, is a silent duplicate.
 */
async function runChain(
  middleware: readonly JobMiddleware[],
  handler: () => Promise<void> | void,
  context: JobContext,
): Promise<void> {
  let misuse: NextMisuse | undefined;
  const refuse = (code: NextMisuse): Promise<void> => {
    misuse ??= code;
    return refusedNext(code);
  };
  const step = async (index: number): Promise<void> => {
    const entry = middleware[index];
    if (entry === undefined) {
      await handler();
      return;
    }
    let open = true;
    let rest: Promise<StepResult> | undefined;
    const next = (): Promise<void> => {
      if (!open) return refuse('middleware_next_late');
      if (rest !== undefined) return refuse('middleware_next_reused');
      const running = step(index + 1);
      // Observed here at once, so a middleware that drops it leaves no
      // unhandled rejection; the step reports it below.
      rest = settle(running);
      return running;
    };
    let own: StepResult = STEP_OK;
    try {
      await entry(context, next);
    } catch (error) {
      own = { ok: false, error };
    }
    open = false;
    const further = rest === undefined ? STEP_OK : await rest;
    if (!own.ok) throw own.error;
    if (!further.ok) throw further.error;
  };
  await step(0);
  if (misuse !== undefined) throw new JobsErrors.Error(misuse);
}

async function runStages(
  spec: JobSpec,
  payload: unknown,
  context: JobContext,
): Promise<StageResult> {
  const parsed = await spec.schema.safeParseAsync(payload);
  if (!parsed.success) return 'invalid_payload';
  await runChain(spec.middleware, () => spec.handle(parsed.data, context), context);
  return 'done';
}

/** The error policy's verdict; a throw or any value but `'discard'` leaves it to the kind. */
function errorPolicy(
  onError: JobErrorHandler | undefined,
  error: unknown,
  context: JobContext,
): 'discard' | undefined {
  if (onError === undefined) return undefined;
  try {
    return onError(error, context) === 'discard' ? 'discard' : undefined;
  } catch {
    // A broken policy must not turn a failure into a second one; the error's
    // kind still decides.
    return undefined;
  }
}

type Restored =
  | { readonly ok: true; readonly execution: ExecutionContext }
  | { readonly ok: false; readonly outcome: AttemptOutcome };

function restore(job: TransportJob, envelope: JobEnvelope, storeErrorMessages: boolean): Restored {
  const carrier = envelope.meta.context;
  try {
    const execution = carrier === undefined ? createExecutionContext() : restoreContext(carrier);
    return { ok: true, execution };
  } catch (error) {
    if (ContextErrors.is(error, 'unsupported_carrier')) {
      return { ok: false, outcome: unknownRelease(job) };
    }
    const { summary } = summarizeJobError(error, { storeMessages: storeErrorMessages });
    return { ok: false, outcome: failed(summary, false) };
  }
}

/** How a definition shapes the flow actions after an attempt; `undefined` for a job this worker does not know. */
type FlowPolicy = Pick<JobSpec, 'onSkip' | 'onFinalFailure'> | undefined;

/** Build the processor a runtime worker hands its adapter. */
export function createProcessor(options: ProcessorOptions): ProcessJob {
  const { catalog, jobs, transport, clock, handlerGraceMs, storeErrorMessages, ledger } = options;
  const summaryOptions = { storeMessages: storeErrorMessages };

  const failure = (error: unknown): AttemptOutcome => {
    const { summary, retryable } = summarizeJobError(error, summaryOptions);
    return failed(summary, retryable);
  };

  /**
   * The flow actions of a settled attempt, after its lease was released (so
   * a chain whose steps share an overlap key never skips its own next step),
   * as follow-ups the adapter stores when it settles the job. A catch whose
   * queue this worker does not declare is left out: only a job that never
   * ran (an unknown one out of releases) gets here with one.
   */
  const settleFlow = (
    job: TransportJob,
    envelope: JobEnvelope,
    policy: FlowPolicy,
    outcome: AttemptOutcome,
  ): AttemptOutcome => {
    const advances =
      outcome.kind === 'completed' ||
      outcome.kind === 'discarded' ||
      (outcome.kind === 'skipped' && policy?.onSkip === 'continue');
    if (advances) {
      const next = chainAdvance(envelope, clock.now());
      return next === undefined
        ? outcome
        : Object.freeze({ ...outcome, followUps: Object.freeze([next]) });
    }
    if (
      outcome.kind !== 'failed' ||
      !isFinalFailure(job.attemptsMade, envelope.options.attempts, outcome.retryable)
    ) {
      return outcome;
    }
    const fired = chainCatch(envelope, clock.now());
    const catchFired = fired !== undefined && catalog.queues.has(fired.queue);
    const drop = policy?.onFinalFailure === 'drop';
    if (!catchFired && !drop) return outcome;
    return Object.freeze({
      ...outcome,
      ...(catchFired ? { catchFired: true as const, followUps: Object.freeze([fired]) } : {}),
      ...(drop ? { drop: true as const } : {}),
    });
  };

  /** Take the overlap lease, or the outcome that ends the attempt without running it. */
  const takeLease = async (
    envelope: JobEnvelope,
    shutdown: AbortSignal,
  ): Promise<
    { readonly lease: OverlapLease | undefined } | { readonly outcome: AttemptOutcome }
  > => {
    const overlap = envelope.meta.overlap;
    if (overlap === undefined) return { lease: undefined };
    const leases = transport.capabilities.leases;
    if (leases === undefined)
      return { outcome: failed(runtimeSummary('capability_missing'), false) };
    let acquired: OverlapLease | 'held';
    try {
      acquired = await acquireOverlapLease(leases, overlap, clock);
    } catch {
      // The store's own error may carry connection details; the attempt
      // fails with the value-free code instead, and is retried.
      return { outcome: failed(runtimeSummary('overlap_unavailable'), true) };
    }
    if (acquired === 'held') return { outcome: SKIPPED };
    if (shutdown.aborted) {
      await acquired.release();
      return { outcome: RELEASED_SHUTDOWN };
    }
    return { lease: acquired };
  };

  /** Run the parse, middleware and handler under one attempt; the lease is released before this resolves. */
  const runHandler = async (
    job: TransportJob,
    envelope: JobEnvelope,
    spec: JobSpec,
    execution: ExecutionContext,
    shutdown: AbortSignal,
    lease: OverlapLease | undefined,
  ): Promise<AttemptOutcome> => {
    const run = new Attempt({
      shutdown,
      timeoutMs: envelope.options.timeoutMs,
      clock,
      handlerGraceMs,
      ledger,
    });
    lease?.watch(() => run.loseLease());
    try {
      const context: JobContext = Object.freeze({
        actor: Object.freeze({ kind: 'system', reason: `job:${spec.name}` }),
        requestId: execution.requestId,
        trace: execution.trace,
        name: spec.name,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        signal: run.signal,
        jobs,
        meta: handlerMeta(envelope.meta),
      });
      const work = runInContext(execution, () => runStages(spec, envelope.payload, context));
      const settled = await run.hold(work);
      if (settled.ok) {
        return settled.value === 'done'
          ? COMPLETED
          : failed(runtimeSummary('invalid_payload'), false);
      }
      const cause = run.cause;
      if (cause === 'shutdown') return RELEASED_SHUTDOWN;
      const error = cause === undefined ? settled.error : (run.abortError ?? settled.error);
      const { summary, retryable } = summarizeJobError(error, summaryOptions);
      const policy = runInContext(execution, () => errorPolicy(spec.onError, error, context));
      return policy === 'discard'
        ? Object.freeze({ kind: 'discarded', error: summary })
        : failed(summary, retryable);
    } finally {
      run.dispose();
      await lease?.release();
    }
  };

  const attempt = async (job: TransportJob, shutdown: AbortSignal): Promise<AttemptOutcome> => {
    const decoded = decodeEnvelope(job.envelope);
    if (!decoded.ok) {
      return decoded.reason === 'newer_version'
        ? unknownRelease(job)
        : failed(runtimeSummary('invalid_envelope'), false);
    }
    const { envelope } = decoded;
    if (envelope.name === BATCH_FINALIZER_JOB) {
      return runBatchFinalizer({
        envelope,
        transport,
        queues: catalog.queues,
        clock,
        summaryOptions,
        skew: unknownRelease(job, 'unknown_queue'),
      });
    }
    const definition = catalog.get(envelope.name);
    if (definition === undefined) return settleFlow(job, envelope, undefined, unknownRelease(job));
    const spec = jobSpec(definition);
    if (!chainQueuesDeclared(envelope, catalog.queues)) {
      return settleFlow(job, envelope, spec, unknownRelease(job, 'unknown_queue'));
    }
    const restored = restore(job, envelope, storeErrorMessages);
    if (!restored.ok) return settleFlow(job, envelope, spec, restored.outcome);
    if (shutdown.aborted) return RELEASED_SHUTDOWN;
    const taken = await takeLease(envelope, shutdown);
    const outcome =
      'outcome' in taken
        ? taken.outcome
        : await runHandler(job, envelope, spec, restored.execution, shutdown, taken.lease);
    return settleFlow(job, envelope, spec, outcome);
  };

  return async (job, shutdown) => {
    ledger.enter();
    try {
      return await attempt(job, shutdown);
    } catch (error) {
      // Totality: a failure of the runtime itself still ends the attempt.
      return failure(error);
    } finally {
      ledger.leave();
    }
  };
}
