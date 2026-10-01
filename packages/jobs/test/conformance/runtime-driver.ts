/**
 * The conformance driver for the new runtime over any adapter. It drives the
 * package's own pieces end to end: `defineJob` and the job catalog for the
 * scenario jobs, the producer for every dispatch (options, payload
 * validation and the envelope are the real ones), the adapter under test for
 * storage, deduplication, delays, attempt counting and failure records, and
 * `startRuntimeWorker` for every worker (the processor, bounded drain and
 * abort, the grace and poisoned-worker rule, version-skew releases, and the
 * job signals, which a recording bus turns into the suite's events).
 *
 * A worker of another release (`knows`) gets a smaller catalog, as it would
 * in a rolling deploy. Flows, failed-job operations, overlap leases and
 * schedules run on the adapter's capabilities: chains and batches through
 * the producer, failed jobs through `capabilities.failedJobs`, schedules
 * through `schedule()` and `reconcileSchedules()` with the adapter's ticker.
 *
 * What a transport does on its own (redelivery after a lost lock, retention,
 * time passing) goes through the {@link DriverTransport} each adapter's test
 * file builds around its own test hooks. The runtime's bounds always run on
 * the real clock; `advance` moves the clock the transport was built with.
 */

import { z } from 'zod';

import type {
  BatchStatus,
  FailedJob,
  FailedJobsCapability,
  JobHandle,
  JobsAdapter,
  QueueDeclaration,
  RetryResult,
} from '../../src/contract/index.js';
import { createJobCatalog, type JobCatalog } from '../../src/definition/catalog.js';
import {
  defineJob,
  type JobCall,
  type JobDefinition,
  type JobMiddleware,
} from '../../src/definition/define-job.js';
import { createProducer, type JobProducer } from '../../src/definition/jobs-service.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { defineQueues, type QueueSet } from '../../src/queues/queue-set.js';
import { startRuntimeWorker, type RuntimeWorker } from '../../src/runtime/runtime-worker.js';
import { schedule } from '../../src/schedules/define-schedule.js';
import {
  pauseSchedules,
  reconcileSchedules,
  resumeSchedules,
} from '../../src/schedules/reconcile.js';
import type {
  DriverOptions,
  JobEvent,
  JobsHarnessDriver,
  ScenarioBatchCallbacks,
  ScenarioCall,
  ScenarioDispatchOptions,
  ScenarioJob,
  ScenarioSchedule,
  StartWorkerOptions,
  WorkerHandle,
} from '../../src/testing/index.js';
import { systemClock, type JobsClock } from '../../src/timing/long-timer.js';
import { RecordingSignalBus } from '../memory/recording-bus.js';
import { VirtualClock } from '../timing/virtual-clock.js';

const SETTLE_BOUND_MS = 10_000;

/** The one queue every scenario uses. */
export const QUEUE = 'default';

/** The queue set of every scenario. */
export const SCENARIO_QUEUES: QueueSet<'default'> = defineQueues({ default: {} });

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** An adapter under test and the hooks that stand for what its store does on its own. */
export interface DriverTransport {
  readonly adapter: JobsAdapter;
  /** Whether an attempt runs, or a running worker has a job it could take now. */
  busy(): boolean | Promise<boolean>;
  /** Deliver a settled job again; false when nothing could be redelivered. */
  redeliver(id: string): boolean | Promise<boolean>;
  /** Drop every completed job of `queue`, as retention does. */
  evictCompleted(queue: string): unknown;
  /**
   * Called after each virtual timer fires and after `advance`: resolve once
   * the work the timer started (a schedule fire, a delayed job falling due)
   * reached the transport, so virtual time never moves past it.
   */
  quiesce(now: number): Promise<void>;
  /** Release what the transport holds besides the adapter, after the adapter closed. */
  close(): Promise<void>;
}

/** What a transport is built for. */
export interface DriverTransportContext {
  readonly queues: readonly QueueDeclaration[];
  /** The clock the adapter's time runs on: virtual when the scenario asks for it. */
  readonly clock: JobsClock;
  readonly virtualTime: boolean;
}

/** Builds the transport of one scenario. */
export type DriverTransportFactory = (
  context: DriverTransportContext,
) => DriverTransport | Promise<DriverTransport>;

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
    ...(job.overlap === undefined
      ? {}
      : { overlap: { key: job.overlap.key, ttlMs: job.overlap.ttlMs } }),
    handle: (payload, context) =>
      job.handle(payload, {
        jobId: context.jobId,
        attempt: context.attempt,
        signal: context.signal,
        dispatch,
      }),
  });
}

class RuntimeDriver implements JobsHarnessDriver {
  readonly #options: DriverOptions;
  readonly #transport: DriverTransport;
  readonly #clock: VirtualClock | undefined;
  readonly #bus = new RecordingSignalBus();
  readonly #workers = new Map<string, RuntimeWorker>();
  readonly #started: RuntimeWorker[] = [];
  #catalog: JobCatalog<'default'> | undefined;
  #producer: JobProducer | undefined;
  #sequence = 0;
  #poisoned = false;

  constructor(options: DriverOptions, transport: DriverTransport, clock: VirtualClock | undefined) {
    this.#options = options;
    this.#transport = transport;
    this.#clock = clock;
  }

  get #adapter(): JobsAdapter {
    return this.#transport.adapter;
  }

  define(jobs: readonly ScenarioJob[]): void {
    const dispatch = this.dispatch.bind(this);
    this.#catalog = createJobCatalog({
      queues: SCENARIO_QUEUES,
      definitions: jobs.map((job) => scenarioDefinition(job, dispatch)),
    });
    this.#producer = createProducer({
      catalog: this.#catalog,
      adapter: this.#adapter,
      clock: this.#clock ?? systemClock,
    });
  }

  #defined(): { catalog: JobCatalog<'default'>; producer: JobProducer } {
    if (this.#catalog === undefined || this.#producer === undefined) {
      throw new Error('define() was not called');
    }
    return { catalog: this.#catalog, producer: this.#producer };
  }

  dispatch(call: ScenarioCall, options: ScenarioDispatchOptions = {}): Promise<JobHandle> {
    return this.#defined().producer.dispatchByName(call.name, call.payload, { ...options });
  }

  /** The typed call of a scenario call, or an `unknown_job` refusal. */
  #call(call: ScenarioCall): JobCall {
    const definition = this.#defined().catalog.get(call.name);
    if (definition === undefined) throw new JobsErrors.Error('unknown_job');
    return definition.with(call.payload);
  }

  async chain(
    steps: readonly ScenarioCall[],
    options: { readonly catch?: ScenarioCall } = {},
  ): Promise<JobHandle> {
    const calls = steps.map((step) => this.#call(step));
    const caught = options.catch === undefined ? undefined : this.#call(options.catch);
    return this.#defined().producer.chain(calls as [JobCall, ...JobCall[]], {
      ...(caught === undefined ? {} : { catch: caught }),
    });
  }

  async batch(
    items: readonly ScenarioCall[],
    callbacks: ScenarioBatchCallbacks,
  ): Promise<{ readonly id: string }> {
    const mapped: { then?: JobCall; catch?: JobCall; finally?: JobCall } = {};
    for (const name of ['then', 'catch', 'finally'] as const) {
      const callback = callbacks[name];
      if (callback !== undefined) mapped[name] = this.#call(callback);
    }
    const handle = await this.#defined().producer.batch(
      items.map((item) => this.#call(item)),
      mapped,
    );
    return { id: handle.id };
  }

  batchStatus(id: string): Promise<BatchStatus | undefined> {
    return this.#defined().producer.batchStatus(id);
  }

  async startWorker(options: StartWorkerOptions = {}): Promise<WorkerHandle> {
    const { catalog } = this.#defined();
    const knows = options.knows;
    // A worker of another release has a smaller catalog, not a filter over this one.
    const scoped =
      knows === undefined
        ? catalog
        : createJobCatalog({
            queues: catalog.queues,
            definitions: catalog.definitions.filter((definition) =>
              knows.includes(definition.name),
            ),
          });
    const worker = await startRuntimeWorker({
      catalog: scoped,
      adapter: this.#adapter,
      // The current producer at each dispatch, so a restarted producer is the one handlers use.
      jobs: {
        dispatch: (call, dispatchOptions) =>
          this.#defined().producer.dispatch(call, dispatchOptions),
        dispatchByName: (name, payload, dispatchOptions) =>
          this.#defined().producer.dispatchByName(name, payload, dispatchOptions),
        chain: (steps, chainOptions) => this.#defined().producer.chain(steps, chainOptions),
        batch: (items, batchOptions) => this.#defined().producer.batch(items, batchOptions),
        batchStatus: (id) => this.#defined().producer.batchStatus(id),
        batchFailures: (id, failureOptions) =>
          this.#defined().producer.batchFailures(id, failureOptions),
      },
      queues: [QUEUE],
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      signals: this.#bus,
      onPoisoned: () => {
        this.#poisoned = true;
      },
    });
    this.#sequence += 1;
    const handle: WorkerHandle = { id: `worker-${this.#sequence}` };
    this.#workers.set(handle.id, worker);
    this.#started.push(worker);
    return handle;
  }

  drain(handle: WorkerHandle): Promise<void> {
    return this.#take(handle).drain({ deadlineMs: this.#options.drainDeadlineMs });
  }

  abort(handle: WorkerHandle): Promise<void> {
    return this.#take(handle).abort();
  }

  #take(handle: WorkerHandle): RuntimeWorker {
    const worker = this.#workers.get(handle.id);
    if (worker === undefined) throw new Error('unknown worker');
    this.#workers.delete(handle.id);
    return worker;
  }

  async redeliver(jobId: string): Promise<void> {
    if (!(await this.#transport.redeliver(jobId))) throw new Error('nothing to redeliver');
    await this.settle();
  }

  async evictCompleted(): Promise<void> {
    await this.#transport.evictCompleted(QUEUE);
  }

  restartProducer(): Promise<void> {
    const { catalog, producer } = this.#defined();
    producer.close();
    this.#producer = createProducer({
      catalog,
      adapter: this.#adapter,
      clock: this.#clock ?? systemClock,
    });
    return Promise.resolve();
  }

  #failedJobs(): FailedJobsCapability {
    const failedJobs = this.#adapter.capabilities.failedJobs;
    if (failedJobs === undefined) throw new Error('the adapter has no failedJobs capability');
    return failedJobs;
  }

  failed(): Promise<readonly FailedJob[]> {
    return this.#failedJobs().list({ queue: QUEUE, limit: 1_000 });
  }

  retry(id: string, options?: { readonly force?: boolean }): Promise<RetryResult> {
    return this.#failedJobs().retry(id, options);
  }

  async reconcileSchedules(schedules: readonly ScenarioSchedule[]): Promise<void> {
    const declared = schedules.map((entry) =>
      schedule(
        entry.id,
        this.#call(entry.call),
        'everyMs' in entry
          ? { everyMs: entry.everyMs }
          : {
              cron: entry.cron,
              ...(entry.timezone === undefined ? {} : { timezone: entry.timezone }),
            },
      ),
    );
    await reconcileSchedules(this.#adapter, declared, {
      app: 'conformance',
      by: 'driver',
      clock: this.#clock ?? systemClock,
    });
  }

  pauseSchedule(id: string): Promise<void> {
    return pauseSchedules(this.#adapter, [id]);
  }

  resumeSchedule(id: string): Promise<void> {
    return resumeSchedules(this.#adapter, [id]);
  }

  async advance(ms: number): Promise<void> {
    const clock = this.#clock;
    if (clock === undefined) throw new Error('advance() needs virtual time');
    await clock.advance(ms, () => this.#transport.quiesce(clock.now()));
    await this.#transport.quiesce(clock.now());
    await this.settle();
  }

  async settle(): Promise<void> {
    const deadline = performance.now() + SETTLE_BOUND_MS;
    let quiet = 0;
    while (quiet < 3) {
      await turn();
      quiet = (await this.#transport.busy()) ? 0 : quiet + 1;
      if (performance.now() > deadline) {
        throw new Error(
          `the ${this.#adapter.name} adapter did not settle within ${SETTLE_BOUND_MS} ms`,
        );
      }
    }
  }

  events(): readonly JobEvent[] {
    return this.#bus.events();
  }

  async close(): Promise<void> {
    this.#workers.clear();
    try {
      // Every worker this driver started, drained or aborted ones included:
      // abort is idempotent and bounded.
      await Promise.all(this.#started.map((worker) => worker.abort()));
      this.#producer?.close();
      await this.#adapter.close();
    } finally {
      await this.#transport.close();
    }
    // No scenario reaches the grace, so a poisoned worker is a regression.
    if (this.#poisoned) throw new Error('a worker was poisoned');
  }
}

/**
 * A driver factory over the transports `transport` builds. Under virtual
 * time the transport's clock starts at `clockStart()`.
 */
export function runtimeDriverFactory(
  transport: DriverTransportFactory,
  clockStart: () => number,
): (options: DriverOptions) => Promise<JobsHarnessDriver> {
  return async (options) => {
    const clock = options.virtualTime ? new VirtualClock(clockStart()) : undefined;
    const built = await transport({
      queues: SCENARIO_QUEUES.declarations,
      clock: clock ?? systemClock,
      virtualTime: options.virtualTime,
    });
    return new RuntimeDriver(options, built, clock);
  };
}
