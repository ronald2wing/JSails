/**
 * In-process job runtime adapter: a {@link JobsRuntimeAdapter} that queues and
 * runs jobs inside the current process, with no Valkey/BullMQ.
 *
 * Meant for development, tests, and single-process tools. It keeps the
 * semantics the runtime relies on — attempts with fixed/exponential backoff,
 * terminal failure for non-retryable errors, delays, `jobId` deduplication,
 * worker concurrency, pause/resume, queue counts, and interval schedules —
 * but nothing is durable: queued jobs die with the process, and producer and
 * worker must share the same adapter instance. Cron schedules need a real
 * scheduler and are rejected; use the BullMQ adapter for them.
 *
 * ```ts
 * const adapter = new MemoryJobsAdapter();
 * const runtime = new JobsRuntimeImpl({ registry, adapter });
 * await runtime.startWorker();
 * await runtime.dispatch('sendEmail', { to: 'a@example.com' });
 * await adapter.drain(); // every queued job has finished
 * ```
 */

import { OVERLAP_OPTION_KEY } from './overlap.js';
import { DEFAULT_ATTEMPTS, DEFAULT_BACKOFF_MS } from './queue.js';
import {
  isJobErrorNonRetryable,
  JobsRuntimeError,
  type JobAdapterContext,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type QueueCounts,
  type RuntimeJob,
  type RuntimeProducer,
  type RuntimeWorker,
  type ScheduleInfo,
} from './runtime.js';
import type { PreparedSchedule } from './scheduler.js';

/** A job held by the in-process queue. */
interface MemoryJob {
  readonly id: string;
  readonly name: string;
  readonly data: unknown;
  readonly opts: Readonly<Record<string, unknown>>;
  /** Whether `id` is a caller-supplied `jobId`, deduplicated while the job exists. */
  readonly explicitId: boolean;
  attemptsMade: number;
  attemptsStarted: number;
}

interface MemorySchedule {
  readonly info: ScheduleInfo;
  readonly timer: ReturnType<typeof setInterval>;
}

/** The shared state of one named queue. */
interface MemoryQueue {
  readonly waiting: MemoryJob[];
  /** Delayed jobs (including retries waiting out their backoff), by timer. */
  readonly timers: Map<ReturnType<typeof setTimeout>, MemoryJob>;
  /** Caller-supplied job ids of jobs that exist (waiting, delayed, or active). */
  readonly ids: Set<string>;
  readonly schedules: Map<string, MemorySchedule>;
  active: number;
  completed: number;
  failed: number;
  paused: boolean;
  concurrency: number;
  processJob: ProcessJob | undefined;
  readonly idle: Array<() => void>;
}

/** Delay before retry number `attempt` (1-based), from the job's backoff option. */
function backoffDelay(backoff: unknown, attempt: number): number {
  if (typeof backoff === 'number') return backoff;
  if (backoff !== null && typeof backoff === 'object') {
    const { type, delay } = backoff as { type?: unknown; delay?: unknown };
    const base = typeof delay === 'number' ? delay : 0;
    return type === 'exponential' ? base * 2 ** (attempt - 1) : base;
  }
  return DEFAULT_BACKOFF_MS * 2 ** (attempt - 1);
}

/** In-process {@link JobsRuntimeAdapter}; see the module comment for its limits. */
export class MemoryJobsAdapter implements JobsRuntimeAdapter {
  readonly name = 'memory';

  readonly #queues = new Map<string, MemoryQueue>();
  readonly #producerQueues = new WeakMap<RuntimeProducer, MemoryQueue>();
  #sequence = 0;

  #queue(name: string): MemoryQueue {
    let queue = this.#queues.get(name);
    if (queue === undefined) {
      queue = {
        waiting: [],
        timers: new Map(),
        ids: new Set(),
        schedules: new Map(),
        active: 0,
        completed: 0,
        failed: 0,
        paused: false,
        concurrency: 1,
        processJob: undefined,
        idle: [],
      };
      this.#queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Resolve once no queue has a running or delayed job, nor a waiting job a
   * worker could pick up (a paused or worker-less queue counts as settled).
   */
  drain(): Promise<void> {
    const busy = [...this.#queues.values()].filter((queue) => !isSettled(queue));
    return Promise.all(
      busy.map((queue) => new Promise<void>((resolve) => queue.idle.push(resolve))),
    ).then(() => undefined);
  }

  #enqueue(queue: MemoryQueue, job: MemoryJob, delayMs: number): void {
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        queue.timers.delete(timer);
        queue.waiting.push(job);
        this.#pump(queue);
      }, delayMs);
      queue.timers.set(timer, job);
      return;
    }
    if (job.opts.lifo === true) {
      queue.waiting.unshift(job);
    } else {
      queue.waiting.push(job);
    }
    this.#pump(queue);
  }

  #pump(queue: MemoryQueue): void {
    const processJob = queue.processJob;
    while (
      processJob !== undefined &&
      !queue.paused &&
      queue.active < queue.concurrency &&
      queue.waiting.length > 0
    ) {
      const job = queue.waiting.shift() as MemoryJob;
      queue.active += 1;
      void this.#run(queue, job, processJob);
    }
    settleIdle(queue);
  }

  async #run(queue: MemoryQueue, job: MemoryJob, processJob: ProcessJob): Promise<void> {
    job.attemptsStarted += 1;
    const runtimeJob: RuntimeJob = {
      name: job.name,
      id: job.id,
      data: job.data,
      attemptsMade: job.attemptsMade,
      attemptsStarted: job.attemptsStarted,
      opts: job.opts,
      log: () => Promise.resolve(),
      updateProgress: () => Promise.resolve(),
    };
    try {
      await processJob(runtimeJob);
      queue.completed += 1;
      forgetId(queue, job);
    } catch (error) {
      job.attemptsMade += 1;
      const attempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
      if (isJobErrorNonRetryable(error) || job.attemptsMade >= attempts) {
        queue.failed += 1;
        forgetId(queue, job);
      } else {
        this.#enqueue(queue, job, backoffDelay(job.opts.backoff, job.attemptsMade));
      }
    } finally {
      queue.active -= 1;
      this.#pump(queue);
    }
  }

  #add(queue: MemoryQueue, name: string, data: unknown, options: JobDispatchOptions): unknown {
    const jobId = typeof options.jobId === 'string' ? options.jobId : undefined;
    // Like BullMQ, a `jobId` deduplicates only while that job exists; once it
    // completes or fails terminally the id can be dispatched again. Generated
    // ids are never tracked, so the set stays bounded by the live jobs.
    if (jobId !== undefined && queue.ids.has(jobId)) {
      return { id: jobId, name };
    }
    let id: string;
    if (jobId === undefined) {
      this.#sequence += 1;
      id = String(this.#sequence);
    } else {
      id = jobId;
      queue.ids.add(id);
    }
    const opts = {
      attempts: DEFAULT_ATTEMPTS,
      backoff: { type: 'exponential', delay: DEFAULT_BACKOFF_MS },
      ...options,
    };
    const delay = typeof options.delay === 'number' ? options.delay : 0;
    this.#enqueue(
      queue,
      {
        id,
        name,
        data,
        opts,
        explicitId: jobId !== undefined,
        attemptsMade: 0,
        attemptsStarted: 0,
      },
      delay,
    );
    return { id, name };
  }

  createProducer(context: JobAdapterContext): RuntimeProducer {
    const queue = this.#queue(context.queueName);
    const producer: RuntimeProducer = {
      dispatch: (name, data, options) => Promise.resolve(this.#add(queue, name, data, options)),
      readCounts: (): Promise<QueueCounts> =>
        Promise.resolve({
          waiting: queue.waiting.length,
          active: queue.active,
          completed: queue.completed,
          failed: queue.failed,
          delayed: queue.timers.size,
        }),
      pause: () => {
        queue.paused = true;
        return Promise.resolve();
      },
      resume: () => {
        queue.paused = false;
        this.#pump(queue);
        return Promise.resolve();
      },
      close: () => {
        for (const schedule of queue.schedules.values()) clearInterval(schedule.timer);
        queue.schedules.clear();
        return Promise.resolve();
      },
    };
    this.#producerQueues.set(producer, queue);
    return producer;
  }

  createWorker(context: JobAdapterContext, processJob: ProcessJob): RuntimeWorker {
    const queue = this.#queue(context.queueName);
    if (queue.processJob !== undefined) {
      throw new JobsRuntimeError(
        'unsupported_operation',
        'the memory adapter runs one worker per queue',
      );
    }
    queue.processJob = processJob;
    queue.concurrency = context.concurrency;
    this.#pump(queue);
    let closing: Promise<void> | undefined;
    return {
      close: (force) => {
        closing ??= (async () => {
          queue.processJob = undefined;
          // Delayed jobs are discarded with the worker; their ids are freed.
          for (const [timer, job] of queue.timers) {
            clearTimeout(timer);
            forgetId(queue, job);
          }
          queue.timers.clear();
          if (force !== true && queue.active > 0) {
            await new Promise<void>((resolve) => queue.idle.push(resolve));
          }
        })();
        return closing;
      },
    };
  }

  #producerQueue(producer: RuntimeProducer): MemoryQueue {
    const queue = this.#producerQueues.get(producer);
    if (queue === undefined) {
      throw new TypeError('memory adapter: the producer was not created by this adapter');
    }
    return queue;
  }

  upsertSchedules(
    producer: RuntimeProducer,
    schedules: readonly PreparedSchedule[],
  ): Promise<void> {
    const queue = this.#producerQueue(producer);
    if (schedules.some((entry) => !('intervalMs' in entry.repeat))) {
      return Promise.reject(
        new JobsRuntimeError(
          'unsupported_operation',
          'the memory adapter supports interval schedules only',
        ),
      );
    }
    for (const entry of schedules) {
      if (!('intervalMs' in entry.repeat)) continue;
      const intervalMs = entry.repeat.intervalMs;
      const existing = queue.schedules.get(entry.id);
      if (existing !== undefined) clearInterval(existing.timer);
      const timer = setInterval(() => {
        const options = entry.overlap === undefined ? {} : { [OVERLAP_OPTION_KEY]: entry.overlap };
        this.#add(queue, entry.job, entry.data, options);
      }, intervalMs);
      // A schedule alone must not keep a dev or test process alive.
      timer.unref();
      queue.schedules.set(entry.id, {
        timer,
        info: {
          id: entry.id,
          job: entry.job,
          repeat: `every ${intervalMs}ms`,
          ...(entry.overlap !== undefined ? { overlap: entry.overlap } : {}),
          ...(entry.description !== undefined ? { description: entry.description } : {}),
        },
      });
    }
    return Promise.resolve();
  }

  listSchedules(producer: RuntimeProducer): Promise<readonly ScheduleInfo[]> {
    const queue = this.#producerQueue(producer);
    return Promise.resolve([...queue.schedules.values()].map((schedule) => schedule.info));
  }

  removeSchedules(producer: RuntimeProducer, ids: readonly string[]): Promise<void> {
    const queue = this.#producerQueue(producer);
    for (const id of ids) {
      const schedule = queue.schedules.get(id);
      if (schedule !== undefined) {
        clearInterval(schedule.timer);
        queue.schedules.delete(id);
      }
    }
    return Promise.resolve();
  }

  pauseSchedules(producer: RuntimeProducer, ids: readonly string[]): Promise<void> {
    return this.removeSchedules(producer, ids);
  }
}

/** Free a job's caller-supplied id once the job no longer exists. */
function forgetId(queue: MemoryQueue, job: MemoryJob): void {
  if (job.explicitId) queue.ids.delete(job.id);
}

/** Nothing running or delayed, and nothing waiting that a worker could pick up. */
function isSettled(queue: MemoryQueue): boolean {
  return (
    queue.active === 0 &&
    queue.timers.size === 0 &&
    (queue.waiting.length === 0 || queue.processJob === undefined || queue.paused)
  );
}

/** Wake `drain()`/`close()` waiters once the queue has settled. */
function settleIdle(queue: MemoryQueue): void {
  if (isSettled(queue)) {
    for (const resolve of queue.idle.splice(0)) resolve();
  }
}
