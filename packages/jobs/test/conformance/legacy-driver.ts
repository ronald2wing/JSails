/**
 * The legacy driver: runs the conformance scenarios against today's
 * `jsails/jobs` runtime, so the suite records which behaviours the code that
 * ships now gets wrong. Test-only; it is deleted with `core/src/jobs`.
 *
 * It wires the most capable configuration the old API allows, not the
 * narrower one `jsails work` builds (which registers no chain or batch
 * middleware and no pause store; `core/test/jobs/conformance/` records that
 * separately). Two processes are modelled over one transport:
 *
 * - the producer: a `JobsRuntimeImpl` used for dispatch, chains, batches,
 *   schedules and retries, plus its own `SharedBatchCoordinator`, whose batch
 *   callbacks live in this process only;
 * - each worker: its own `JobsRuntimeImpl` and coordinator, with the chain and
 *   batch middleware on every job, overlap through a shared lease store (automatic
 *   by default, or the explicit per-job stack, see
 *   {@link LegacyOverlapPlacement}), and the shared failed-job history.
 *
 * The shared services (cache, leases, failed-job history, pause store) stand
 * for Valkey and the database. A legacy flow callback is a closure, so it is
 * mapped to "dispatch the callback job from the producer"; a producer restart
 * makes the old closures inert, which is what a process exit does to them.
 *
 * A redelivery re-invokes the processor with the job as it was last
 * delivered, which is what the transport does after a lost lock or a stalled
 * worker. Legacy dispatch results do not say whether a key deduplicated, so
 * every handle reports `deduplicated: false`; scenarios observe executions.
 *
 * The legacy runtime has no chain catch, so a chain with one throws; a forced
 * retry is the legacy retry (it has no catch to guard); a resume re-upserts
 * the schedule as last reconciled, which is how the legacy runtime resumes;
 * and a cron schedule is registered as a legacy cron schedule.
 */

import { mock } from 'node:test';

import { JOB_ENVELOPE_VERSION } from '../../src/contract/index.js';

import { MemoryCacheStore, MemoryLeaseStore } from '@jsails/cache';
import {
  CachePausedScheduleStore,
  FailedJobNotFoundError,
  InMemoryFailedJobHistory,
  JobsRuntimeImpl,
  OVERLAP_OPTION_KEY,
  SharedBatchCoordinator,
  TAG_OPTION_KEY,
  chainMiddleware,
  createBatchMiddleware,
  createJobBatch,
  createJobChain,
  createJobRegistry,
  createOverlapMiddleware,
  defineJob,
  jobCompleted,
  jobFailed,
  retryFailedJob,
  type BatchCallbacks,
  type FailedJobEntry,
  type JobContext,
  type JobDefinition,
  type JobMiddleware,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
} from 'jsails/jobs';
import type { SignalBus } from 'jsails/signals';
import { z } from 'zod';

import type { FailedJob, JobHandle, RetryResult } from '../../src/index.js';
import type {
  DriverOptions,
  JobEvent,
  JobsHarnessDriver,
  ScenarioBatchCallbacks,
  ScenarioCall,
  ScenarioDispatchOptions,
  ScenarioJob,
  ScenarioSchedule,
  WorkerHandle,
} from '../../src/testing/index.js';

const SETTLE_BOUND_MS = 5_000;
const TICK_STEP_MS = 250;

/** The transport a legacy driver runs over. */
export interface LegacyTransport {
  readonly adapter: JobsRuntimeAdapter;
  readonly queueName: string;
  readonly prefix: string;
  /** Release whatever the transport itself holds (connections). */
  close(): Promise<void>;
}

/**
 * Where overlap control sits in a worker's middleware stack. `automatic` is
 * what the runtime installs from `overlapLeases`: outermost, before the chain
 * middleware. `explicit` is the documented per-job stack
 * `[chainMiddleware, batch, createOverlapMiddleware(leases)]`, which stops the
 * runtime adding its own, so overlap runs inside the chain middleware.
 */
export type LegacyOverlapPlacement = 'automatic' | 'explicit';

export interface LegacyDriverOptions {
  readonly overlap: LegacyOverlapPlacement;
}

/** Wrap an adapter so every worker's processor and every delivered job is visible. */
function capturingAdapter(
  inner: JobsRuntimeAdapter,
  processors: ProcessJob[],
  delivered: Map<string, RuntimeJob>,
): JobsRuntimeAdapter {
  return {
    name: inner.name,
    createProducer: (context) => inner.createProducer(context),
    createWorker: (context, processJob) => {
      processors.push(processJob);
      return inner.createWorker(context, (job) => {
        if (job.id !== undefined) delivered.set(job.id, job);
        return processJob(job);
      });
    },
    ...(inner.upsertSchedules === undefined
      ? {}
      : { upsertSchedules: inner.upsertSchedules.bind(inner) }),
    ...(inner.listSchedules === undefined
      ? {}
      : { listSchedules: inner.listSchedules.bind(inner) }),
    ...(inner.pauseSchedules === undefined
      ? {}
      : { pauseSchedules: inner.pauseSchedules.bind(inner) }),
    ...(inner.removeSchedules === undefined
      ? {}
      : { removeSchedules: inner.removeSchedules.bind(inner) }),
  };
}

/** A signal bus that records job outcomes as harness events. */
function recordingBus(events: JobEvent[]): SignalBus {
  return {
    observe: () => undefined,
    emit: (event, payload) => {
      const kind =
        event === jobCompleted ? 'completed' : event === jobFailed ? 'failed' : undefined;
      if (kind !== undefined) {
        const { name, jobId } = payload as { name: string; jobId?: string };
        events.push({ kind, name, jobId });
      }
      return Promise.resolve([]);
    },
  };
}

/** The id a legacy dispatch result carries. */
function handleOf(result: unknown): JobHandle {
  const id = (result as { id?: unknown } | null)?.id;
  return { id: String(id), deduplicated: false };
}

/** The legacy shape of a failed-job entry, as the contract's {@link FailedJob}. */
function failedJobOf(entry: FailedJobEntry, queue: string): FailedJob {
  return {
    id: entry.id,
    queue: entry.queue ?? queue,
    envelope: {
      v: JOB_ENVELOPE_VERSION,
      name: entry.name,
      payload: entry.data,
      options: {},
      meta: {
        ...(entry.tags === undefined ? {} : { tags: entry.tags }),
        dispatchedAt: entry.failedAt.getTime(),
      },
    },
    error: {
      name: entry.errorName ?? 'Error',
      kind: 'internal',
      ...(entry.errorCode === undefined ? {} : { code: entry.errorCode }),
    },
    failedAt: entry.failedAt.getTime(),
  };
}

/** A scenario schedule as a legacy schedule definition. */
function legacySchedule(schedule: ScenarioSchedule): {
  readonly id: string;
  readonly job: string;
  readonly data: unknown;
  readonly intervalMs?: number;
  readonly cron?: string;
  readonly timezone?: string;
} {
  const base = { id: schedule.id, job: schedule.call.name, data: schedule.call.payload };
  if ('everyMs' in schedule) return { ...base, intervalMs: schedule.everyMs };
  return {
    ...base,
    cron: schedule.cron,
    ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
  };
}

/** The options `jsails queue:retry` replays for an entry. */
function replayOptions(entry: FailedJobEntry): Record<string, unknown> {
  return {
    ...entry.options,
    ...(entry.tags === undefined ? {} : { [TAG_OPTION_KEY]: entry.tags }),
  };
}

interface LegacyProcess {
  readonly runtime: JobsRuntimeImpl;
  readonly coordinator: SharedBatchCoordinator;
}

interface LegacyWorker extends LegacyProcess {
  readonly handle: WorkerHandle;
  closing: Promise<void> | undefined;
}

class LegacyDriver implements JobsHarnessDriver {
  readonly #transport: LegacyTransport;
  readonly #options: DriverOptions;
  readonly #overlap: LegacyOverlapPlacement;
  readonly #events: JobEvent[] = [];
  readonly #processors: ProcessJob[] = [];
  readonly #delivered = new Map<string, RuntimeJob>();
  readonly #adapter: JobsRuntimeAdapter;
  readonly #cache = new MemoryCacheStore();
  readonly #leases = new MemoryLeaseStore();
  readonly #history = new InMemoryFailedJobHistory();
  readonly #paused: CachePausedScheduleStore;
  readonly #signals: SignalBus;
  readonly #workers = new Map<string, LegacyWorker>();
  /** The schedules last reconciled, by id, for a resume to re-upsert. */
  readonly #declared = new Map<string, ScenarioSchedule>();
  #jobs = new Map<string, ScenarioJob>();
  #producer: LegacyProcess | undefined;
  #generation = 0;
  #workerSequence = 0;
  #redeliveries = 0;

  constructor(transport: LegacyTransport, options: DriverOptions, legacy: LegacyDriverOptions) {
    this.#transport = transport;
    this.#options = options;
    this.#overlap = legacy.overlap;
    this.#adapter = capturingAdapter(transport.adapter, this.#processors, this.#delivered);
    this.#paused = new CachePausedScheduleStore(this.#cache);
    this.#signals = recordingBus(this.#events);
  }

  define(jobs: readonly ScenarioJob[]): void {
    this.#jobs = new Map(jobs.map((job) => [job.name, job]));
    this.#producer = this.#newProcess(this.#registry(), undefined);
  }

  /** The dispatch options a definition implies, plus the scenario's own. */
  #legacyOptions(name: string, options: ScenarioDispatchOptions = {}): Record<string, unknown> {
    const job = this.#jobs.get(name);
    return {
      attempts: job?.attempts ?? 1,
      backoff: 0,
      ...(job?.overlap === undefined ? {} : { [OVERLAP_OPTION_KEY]: job.overlap }),
      ...(options.key === undefined ? {} : { jobId: options.key }),
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
      ...(options.tags === undefined ? {} : { [TAG_OPTION_KEY]: options.tags }),
    };
  }

  #definition(job: ScenarioJob): JobDefinition {
    const accepts = job.accepts ?? (() => true);
    return defineJob({
      schema: z.custom<unknown>((value) => accepts(value)),
      handler: (payload: unknown, context: JobContext) =>
        job.handle(payload, {
          jobId: String(context.jobId),
          attempt: context.attemptsMade + 1,
          signal: context.signal ?? new AbortController().signal,
          dispatch: async (call, options) => {
            if (context.dispatch === undefined) throw new Error('no dispatch in job context');
            return handleOf(
              await context.dispatch(
                call.name,
                call.payload,
                this.#legacyOptions(call.name, options),
              ),
            );
          },
        }),
    });
  }

  #registry(knows?: readonly string[]): Readonly<Record<string, JobDefinition>> {
    const entries = [...this.#jobs.values()]
      .filter((job) => knows === undefined || knows.includes(job.name))
      .map((job) => [job.name, this.#definition(job)] as const);
    return createJobRegistry(Object.fromEntries(entries));
  }

  #middleware(coordinator: SharedBatchCoordinator): Record<string, JobMiddleware[]> {
    const batch = createBatchMiddleware(coordinator);
    return Object.fromEntries(
      [...this.#jobs.values()].map((job) => {
        const own = job.middleware;
        const middleware: JobMiddleware[] = [chainMiddleware, batch];
        if (this.#overlap === 'explicit' && job.overlap !== undefined) {
          middleware.push(createOverlapMiddleware(this.#leases));
        }
        if (own !== undefined) {
          middleware.push(async (_data, context, next) => {
            await own(
              { name: context.name, signal: context.signal ?? new AbortController().signal },
              async () => {
                await next();
              },
            );
          });
        }
        return [job.name, middleware];
      }),
    );
  }

  #newProcess(
    registry: Readonly<Record<string, JobDefinition>>,
    concurrency: number | undefined,
  ): LegacyProcess {
    const coordinator = new SharedBatchCoordinator(this.#cache, { pollIntervalMs: 10 });
    const runtime = new JobsRuntimeImpl({
      registry,
      adapter: this.#adapter,
      queueName: this.#transport.queueName,
      prefix: this.#transport.prefix,
      ...(concurrency === undefined ? {} : { concurrency }),
      middleware: this.#middleware(coordinator),
      overlapLeases: this.#leases,
      signals: this.#signals,
      pausedSchedules: this.#paused,
      failedJobs: this.#history,
      shutdownTimeoutMs: this.#options.drainDeadlineMs,
      onJobFailed: false,
    });
    return { runtime, coordinator };
  }

  get #producerProcess(): LegacyProcess {
    if (this.#producer === undefined) throw new Error('define() was not called');
    return this.#producer;
  }

  async dispatch(call: ScenarioCall, options?: ScenarioDispatchOptions): Promise<JobHandle> {
    return handleOf(
      await this.#producerProcess.runtime.dispatch(
        call.name,
        call.payload,
        this.#legacyOptions(call.name, options),
      ),
    );
  }

  async chain(
    steps: readonly ScenarioCall[],
    options: { readonly catch?: ScenarioCall } = {},
  ): Promise<JobHandle> {
    if (options.catch !== undefined) throw new Error('the legacy runtime has no chain catch');
    const chain = createJobChain(
      this.#producerProcess.runtime,
      steps.map((step) => ({
        job: step.name,
        data: step.payload,
        opts: this.#legacyOptions(step.name),
      })),
    );
    return handleOf(await chain.dispatch());
  }

  async batch(
    items: readonly ScenarioCall[],
    callbacks: ScenarioBatchCallbacks,
  ): Promise<{ readonly id: string }> {
    const producer = this.#producerProcess;
    const generation = this.#generation;
    const fire = (call: ScenarioCall | undefined) =>
      call === undefined
        ? undefined
        : async () => {
            // A callback of a producer that has since restarted died with it.
            if (generation !== this.#generation) return;
            await producer.runtime.dispatch(
              call.name,
              call.payload,
              this.#legacyOptions(call.name),
            );
          };
    const thenCallback = fire(callbacks.then);
    const catchCallback = fire(callbacks.catch);
    const finallyCallback = fire(callbacks.finally);
    const legacyCallbacks: BatchCallbacks = {
      ...(thenCallback === undefined ? {} : { then: thenCallback }),
      ...(catchCallback === undefined ? {} : { catch: catchCallback }),
      ...(finallyCallback === undefined ? {} : { finally: finallyCallback }),
    };
    const batch = createJobBatch(
      producer.runtime,
      producer.coordinator,
      items.map((item) => ({
        job: item.name,
        data: item.payload,
        opts: this.#legacyOptions(item.name),
      })),
      legacyCallbacks,
    );
    await batch.dispatch();
    return { id: batch.id };
  }

  batchStatus(): Promise<undefined> {
    // The legacy batch API has no status read.
    return Promise.resolve(undefined);
  }

  async startWorker(
    options: { readonly concurrency?: number; readonly knows?: readonly string[] } = {},
  ): Promise<WorkerHandle> {
    this.#workerSequence += 1;
    const handle: WorkerHandle = { id: `worker-${this.#workerSequence}` };
    const worker: LegacyWorker = {
      ...this.#newProcess(this.#registry(options.knows), options.concurrency),
      handle,
      closing: undefined,
    };
    this.#workers.set(handle.id, worker);
    await worker.runtime.startWorker();
    return handle;
  }

  #closeWorker(handle: WorkerHandle): Promise<void> {
    const worker = this.#workers.get(handle.id);
    if (worker === undefined) throw new Error(`unknown worker ${handle.id}`);
    worker.closing ??= worker.runtime.close().finally(() => {
      this.#workers.delete(handle.id);
    });
    return worker.closing;
  }

  drain(worker: WorkerHandle): Promise<void> {
    return this.#closeWorker(worker);
  }

  abort(worker: WorkerHandle): Promise<void> {
    // The legacy runtime has one shutdown: drain up to the deadline, then abort.
    return this.#closeWorker(worker);
  }

  async redeliver(jobId: string): Promise<void> {
    const job = this.#delivered.get(jobId);
    if (job === undefined) throw new Error(`job ${jobId} was never delivered`);
    // The most recent worker's processor: the one a transport would hand it to.
    const processJob = this.#processors.at(-1);
    if (processJob === undefined) throw new Error('no worker to redeliver to');
    this.#redeliveries += 1;
    try {
      await processJob(job);
    } catch {
      // A failed redelivered attempt is an outcome the scenario observes
      // through executions and the failed set, not an error of the driver.
    } finally {
      this.#redeliveries -= 1;
    }
  }

  evictCompleted(): Promise<void> {
    // The memory adapter forgets a job as soon as it completes, and the
    // Valkey transport is configured with `removeOnComplete: true`.
    return Promise.resolve();
  }

  async restartProducer(): Promise<void> {
    const old = this.#producerProcess;
    this.#generation += 1;
    this.#producer = this.#newProcess(this.#registry(), undefined);
    await old.runtime.close();
  }

  async failed(): Promise<readonly FailedJob[]> {
    const entries = await this.#history.list();
    return entries.map((entry) => failedJobOf(entry, this.#transport.queueName));
  }

  async retry(id: string): Promise<RetryResult> {
    try {
      const result = await retryFailedJob(this.#history, id, (entry) =>
        this.#producerProcess.runtime.dispatch(entry.name, entry.data, replayOptions(entry)),
      );
      if (result.status !== 'dispatched') throw result.dispatchError;
      return 'retried';
    } catch (error) {
      if (error instanceof FailedJobNotFoundError) return 'not_found';
      throw error;
    }
  }

  async reconcileSchedules(schedules: readonly ScenarioSchedule[]): Promise<void> {
    this.#declared.clear();
    for (const schedule of schedules) this.#declared.set(schedule.id, schedule);
    await this.#producerProcess.runtime.upsertSchedules(schedules.map(legacySchedule));
  }

  async pauseSchedule(id: string): Promise<void> {
    await this.#producerProcess.runtime.pauseSchedules([id]);
  }

  async resumeSchedule(id: string): Promise<void> {
    const schedule = this.#declared.get(id);
    if (schedule === undefined) throw new Error(`schedule ${id} was never reconciled`);
    await this.#producerProcess.runtime.upsertSchedules([legacySchedule(schedule)], {
      prune: false,
    });
  }

  async advance(ms: number): Promise<void> {
    if (!this.#options.virtualTime) throw new Error('advance() needs virtual time');
    // MockTimers runs a due timer with the clock already at the end of the
    // tick, so a timer armed inside it starts late by up to the tick length.
    // Small steps keep a re-armed long timer within the scenario's margin.
    for (let left = ms; left > 0; left -= TICK_STEP_MS) {
      mock.timers.tick(Math.min(left, TICK_STEP_MS));
    }
    await this.settle();
  }

  async settle(): Promise<void> {
    const deadline = performance.now() + SETTLE_BOUND_MS;
    let quiet = 0;
    while (quiet < 3) {
      await new Promise((resolve) => setImmediate(resolve));
      const counts = await this.#producerProcess.runtime.readCounts();
      const runnable = this.#workers.size > 0 ? counts.waiting : 0;
      quiet = counts.active === 0 && runnable === 0 && this.#redeliveries === 0 ? quiet + 1 : 0;
      if (performance.now() > deadline) {
        throw new Error(`the legacy queue did not settle within ${SETTLE_BOUND_MS} ms`);
      }
    }
  }

  events(): readonly JobEvent[] {
    return [...this.#events];
  }

  async close(): Promise<void> {
    if (this.#options.virtualTime) mock.timers.reset();
    for (const worker of [...this.#workers.values()]) {
      await this.#closeWorker(worker.handle);
    }
    await this.#producer?.runtime.close();
    await this.#transport.close();
    await this.#leases.close();
    await this.#cache.close();
  }
}

/** Build a legacy driver over `transport`, enabling fake timers for virtual time. */
export function createLegacyDriver(
  transport: LegacyTransport,
  options: DriverOptions,
  legacy: LegacyDriverOptions = { overlap: 'automatic' },
): JobsHarnessDriver {
  if (options.virtualTime) {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  }
  return new LegacyDriver(transport, options, legacy);
}
