/**
 * The conformance driver for the new runtime over the memory adapter. It
 * drives the package's own pieces: `defineJob` and the job catalog for the
 * scenario jobs, the producer for every dispatch (so options, payload
 * validation and the envelope are the real ones), and `MemoryJobsAdapter` for
 * storage, deduplication, delays and attempt counting.
 *
 * The worker runtime (the processor, bounded drain and abort, the grace and
 * poisoned-worker rule) and flows, failed-job operations, overlap leases and
 * schedules arrive in later work packages. Until then:
 *
 * - attempts run through {@link standInProcessor}, the smallest processor the
 *   contract allows: decode, look the job up, parse, run middleware and
 *   handler with no bound of its own, map the result to an outcome;
 * - the operations that need a missing piece throw {@link NotYetSupported},
 *   so their scenarios fail with a message that names it, and the failures
 *   are listed in `scripts/expected-failures/jobs.json`;
 * - the failed set is read from the adapter's final settle events, which is
 *   what a failed job is until the failed-jobs capability exists.
 */

import { z } from 'zod';

import type {
  AdapterWorker,
  AttemptOutcome,
  BatchStatus,
  FailedJob,
  JobHandle,
  ProcessJob,
  RetryResult,
  SettleEvent,
} from '../../src/contract/index.js';
import { createJobCatalog, type JobCatalog } from '../../src/definition/catalog.js';
import {
  defineJob,
  jobSpec,
  type JobContext,
  type JobDefinition,
  type JobMiddleware,
} from '../../src/definition/define-job.js';
import { createProducer, type JobProducer } from '../../src/definition/jobs-service.js';
import { decodeEnvelope } from '../../src/envelope/codec.js';
import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import type {
  DriverOptions,
  JobEvent,
  JobsHarnessDriver,
  ScenarioCall,
  ScenarioDispatchOptions,
  ScenarioJob,
  StartWorkerOptions,
  WorkerHandle,
} from '../../src/testing/index.js';
import { systemClock } from '../../src/timing/long-timer.js';
import { VirtualClock } from '../timing/virtual-clock.js';

const SETTLE_BOUND_MS = 5_000;
const UNKNOWN_RELEASE_MS = 50;
const MAX_UNKNOWN_RELEASES = 10;
const QUEUE = 'default';

/** An operation whose implementation arrives with a later work package. */
export class NotYetSupported extends Error {
  override readonly name = 'NotYetSupported';
  constructor(operation: string, owner: string) {
    super(`the memory driver cannot ${operation} until ${owner} lands`);
  }
}

const realSetTimeout = globalThis.setTimeout;

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function failedOutcome(retryable: boolean, name: string): AttemptOutcome {
  return { kind: 'failed', error: { kind: retryable ? 'handler' : 'validation', name }, retryable };
}

/**
 * The stand-in processor. It knows the jobs of `catalog` that `knows` lets it
 * know; it does not bound a handler that ignores its signal.
 */
function standInProcessor(
  catalog: JobCatalog,
  producer: () => JobProducer,
  knows: ReadonlySet<string> | undefined,
): ProcessJob {
  return async (job, signal) => {
    const decoded = decodeEnvelope(job.envelope);
    if (!decoded.ok && decoded.reason === 'malformed')
      return failedOutcome(false, 'MalformedEnvelope');
    const definition = decoded.ok ? catalog.get(decoded.envelope.name) : undefined;
    if (
      !decoded.ok ||
      definition === undefined ||
      (knows !== undefined && !knows.has(definition.name))
    ) {
      return job.unknownReleases >= MAX_UNKNOWN_RELEASES
        ? failedOutcome(false, 'UnknownJob')
        : { kind: 'released', reason: 'unknown_job', delayMs: UNKNOWN_RELEASE_MS };
    }
    const spec = jobSpec(definition);
    const parsed = await spec.schema.safeParseAsync(decoded.envelope.payload);
    if (!parsed.success) return failedOutcome(false, 'InvalidPayload');
    const context: JobContext = {
      name: spec.name,
      jobId: job.id,
      attempt: job.attemptsMade + 1,
      signal,
      jobs: producer(),
      meta: decoded.envelope.meta,
    };
    const run = (index: number): Promise<void> => {
      const middleware = spec.middleware[index];
      if (middleware === undefined) return Promise.resolve(spec.handle(parsed.data, context));
      return middleware(context, () => run(index + 1));
    };
    try {
      await run(0);
      return { kind: 'completed' };
    } catch (error) {
      if (signal.aborted) return { kind: 'released', reason: 'shutdown' };
      return failedOutcome(true, error instanceof Error ? error.name : 'Error');
    }
  };
}

function scenarioDefinition(
  job: ScenarioJob,
  dispatch: JobsHarnessDriver['dispatch'],
): JobDefinition<string, z.ZodType, 'default'> {
  const accepts = job.accepts ?? (() => true);
  const middleware: JobMiddleware[] = [];
  if (job.middleware !== undefined) {
    const scenario = job.middleware;
    middleware.push((context, next) =>
      scenario({ name: context.name, signal: context.signal }, next),
    );
  }
  return defineJob({
    name: job.name,
    schema: z.custom<unknown>((value) => accepts(value)),
    attempts: job.attempts ?? 1,
    backoff: { type: 'fixed', delayMs: 0 },
    middleware,
    handle: (payload, context) =>
      job.handle(payload, {
        jobId: context.jobId,
        attempt: context.attempt,
        signal: context.signal,
        dispatch,
      }),
  });
}

class MemoryDriver implements JobsHarnessDriver {
  readonly #options: DriverOptions;
  readonly #clock: VirtualClock | undefined;
  readonly #events: JobEvent[] = [];
  readonly #failed: FailedJob[] = [];
  readonly #workers = new Map<string, AdapterWorker>();
  #catalog: JobCatalog | undefined;
  #adapter: MemoryJobsAdapter | undefined;
  #producer: JobProducer | undefined;
  #sequence = 0;

  constructor(options: DriverOptions) {
    this.#options = options;
    this.#clock = options.virtualTime ? new VirtualClock(1_700_000_000_000) : undefined;
  }

  define(jobs: readonly ScenarioJob[]): void {
    const dispatch = this.dispatch.bind(this);
    this.#catalog = createJobCatalog({
      // Completed jobs are evicted at once, so every key scenario runs
      // against a transport that no longer holds the first job.
      queues: defineQueues({ default: { retention: { completed: { count: 0 } } } }),
      definitions: jobs.map((job) => scenarioDefinition(job, dispatch)),
    });
    const clock = this.#clock ?? systemClock;
    this.#adapter = new MemoryJobsAdapter(
      { namespace: 'conformance:test', queues: this.#catalog.queues.declarations },
      { clock },
    );
    this.#producer = createProducer({ catalog: this.#catalog, adapter: this.#adapter, clock });
  }

  #defined(): { catalog: JobCatalog; adapter: MemoryJobsAdapter; producer: JobProducer } {
    if (
      this.#catalog === undefined ||
      this.#adapter === undefined ||
      this.#producer === undefined
    ) {
      throw new Error('define() was not called');
    }
    return { catalog: this.#catalog, adapter: this.#adapter, producer: this.#producer };
  }

  dispatch(call: ScenarioCall, options: ScenarioDispatchOptions = {}): Promise<JobHandle> {
    return this.#defined().producer.dispatchByName(call.name, call.payload, { ...options });
  }

  chain(): Promise<JobHandle> {
    return Promise.reject(new NotYetSupported('run a chain', 'JOB-04'));
  }

  batch(): Promise<{ readonly id: string }> {
    return Promise.reject(new NotYetSupported('run a batch', 'JOB-04'));
  }

  batchStatus(): Promise<BatchStatus | undefined> {
    return Promise.reject(new NotYetSupported('read a batch status', 'JOB-04'));
  }

  async startWorker(options: StartWorkerOptions = {}): Promise<WorkerHandle> {
    const { catalog, adapter } = this.#defined();
    const knows = options.knows === undefined ? undefined : new Set(options.knows);
    const worker = await adapter.startWorker(
      {
        queues: [QUEUE],
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        onSettle: (event) => this.#record(event),
      },
      standInProcessor(catalog, () => this.#defined().producer, knows),
    );
    this.#sequence += 1;
    const handle: WorkerHandle = { id: `worker-${this.#sequence}` };
    this.#workers.set(handle.id, worker);
    return handle;
  }

  #record(event: SettleEvent): void {
    const name = event.job.envelope.name;
    const { outcome } = event;
    const kind: JobEvent['kind'] | undefined =
      outcome.kind === 'completed' || outcome.kind === 'discarded'
        ? 'completed'
        : outcome.kind === 'failed'
          ? event.final
            ? 'failed'
            : undefined
          : outcome.kind;
    if (kind !== undefined) this.#events.push({ kind, name, jobId: event.job.id });
    if (outcome.kind === 'failed' && event.final) {
      this.#failed.push({
        id: event.job.id,
        queue: event.job.queue,
        envelope: event.job.envelope,
        error: outcome.error,
        failedAt: (this.#clock ?? systemClock).now(),
      });
    }
  }

  async drain(handle: WorkerHandle): Promise<void> {
    const worker = this.#take(handle);
    let drained = false;
    const draining = worker.drain().then(() => {
      drained = true;
    });
    await Promise.race([draining, realDelay(this.#options.drainDeadlineMs)]);
    if (!drained) await worker.abort();
    await draining;
  }

  abort(handle: WorkerHandle): Promise<void> {
    return this.#take(handle).abort();
  }

  #take(handle: WorkerHandle): AdapterWorker {
    const worker = this.#workers.get(handle.id);
    if (worker === undefined) throw new Error('unknown worker');
    this.#workers.delete(handle.id);
    return worker;
  }

  redeliver(): Promise<void> {
    return Promise.reject(new NotYetSupported('redeliver a job', 'JOB-04'));
  }

  evictCompleted(): Promise<void> {
    // The queue's completed retention is zero: completed jobs are already gone.
    return Promise.resolve();
  }

  restartProducer(): Promise<void> {
    const { catalog, adapter, producer } = this.#defined();
    producer.close();
    this.#producer = createProducer({ catalog, adapter, clock: this.#clock ?? systemClock });
    return Promise.resolve();
  }

  failed(): Promise<readonly FailedJob[]> {
    return Promise.resolve([...this.#failed]);
  }

  retry(): Promise<RetryResult> {
    return Promise.reject(new NotYetSupported('retry a failed job', 'JOB-04'));
  }

  reconcileSchedules(): Promise<void> {
    return Promise.reject(new NotYetSupported('reconcile schedules', 'JOB-04'));
  }

  pauseSchedule(): Promise<void> {
    return Promise.reject(new NotYetSupported('pause a schedule', 'JOB-04'));
  }

  async advance(ms: number): Promise<void> {
    if (this.#clock === undefined) throw new Error('advance() needs virtual time');
    await this.#clock.advance(ms);
    await this.settle();
  }

  async settle(): Promise<void> {
    const deadline = performance.now() + SETTLE_BOUND_MS;
    let quiet = 0;
    while (quiet < 3) {
      await turn();
      quiet = this.#adapter?.busy() === true ? 0 : quiet + 1;
      if (performance.now() > deadline) {
        throw new Error(`the memory adapter did not settle within ${SETTLE_BOUND_MS} ms`);
      }
    }
  }

  events(): readonly JobEvent[] {
    return [...this.#events];
  }

  async close(): Promise<void> {
    const workers = [...this.#workers.values()];
    this.#workers.clear();
    await Promise.all(workers.map((worker) => worker.abort()));
    this.#producer?.close();
    await this.#adapter?.close();
  }
}

/** A fresh memory driver for one scenario. */
export function createMemoryDriver(options: DriverOptions): JobsHarnessDriver {
  return new MemoryDriver(options);
}
