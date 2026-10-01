/**
 * The in-memory transport: a complete {@link JobsAdapter} that keeps every
 * job in this process. It is the development and test transport, so its
 * `reach` is `process`: producer and worker must share the process, and the
 * kernel refuses to split them over it.
 *
 * It holds the contract a shared transport holds:
 *
 * - a key deduplicates on its queue for its window, whatever happened to the
 *   first job, eviction included (keys live in their own expiry map, apart
 *   from the jobs);
 * - a delayed job, a retry backoff, or a release delay waits on a
 *   `setLongTimeout`, so a 30-day delay fires once, after 30 days;
 * - the adapter owns attempt counting: a `released` outcome returns the job
 *   to its queue without spending an attempt, a retryable `failed` outcome
 *   spends one and waits out the backoff, and the settle event says whether
 *   the outcome was final;
 * - a job stays held by its worker until the processor's promise settles,
 *   so a job never runs alongside an attempt of itself; `abort()` and
 *   `close()` wait for that, unbounded, because bounding the wait is the
 *   runtime's job (`RuntimeWorker.abort`), not the transport's;
 * - every outcome is checked field by field (`checkedAttemptOutcome`) before
 *   it is applied, so only a well-formed, value-free failure summary is ever
 *   stored;
 * - settled jobs are kept per the queue's retention, the failed ones being
 *   the failed-job list with their summary and failure time;
 * - a job that settles back into its queue after `close()` (a shutdown
 *   release, a retry) is kept as waiting or delayed, with no timer and no
 *   worker to run it, so the store never loses it.
 *
 * Every delivery hands the processor a fresh copy of the stored envelope, as
 * a serializing transport does, so a handler that mutates its payload cannot
 * change what a later attempt sees.
 *
 * It provides all four capabilities, each operation one synchronous step and
 * so atomic in the process:
 *
 * - `flows`: batches, with each child's first final outcome recorded in the
 *   step that settles it and the held finalizer released once
 *   ({@link BatchStore});
 * - `failedJobs`: the retained failed jobs, listed newest first, retried
 *   under the same id with the same stored envelope;
 * - `schedules`: the stored schedules with their pause state
 *   ({@link ScheduleStore}), fired by a schedule ticker on the adapter's
 *   clock while at least one worker runs, so a producer-only process never
 *   fires;
 * - `leases`: owner-token leases on the adapter's clock ({@link LeaseTable}).
 *
 * An outcome's follow-ups (a chain's next step or catch, a batch's
 * callbacks) are stored in the step that settles the job, as `enqueue` would
 * store them; one that does not decode or names an undeclared queue makes
 * the outcome {@link PROCESSOR_BROKE_CONTRACT}. A final failure the
 * processor flags `catchFired` has the flag written onto its stored
 * envelope, and one flagged `drop` is deleted, both in that same step.
 *
 * Two test hooks stand for what a shared transport does on its own:
 * {@link MemoryJobsAdapter.redeliver} delivers a settled job again, as after
 * a lost lock, and {@link MemoryJobsAdapter.evictCompleted} applies retention
 * to completed jobs at once.
 */

import {
  checkedAttemptOutcome,
  isFinalFailure,
  PROCESSOR_BROKE_CONTRACT,
  type AdapterWorker,
  type AttemptOutcome,
  type BatchEnqueue,
  type FailedJob,
  type FailedJobRef,
  type FailedJobsCapability,
  type FlowTransport,
  type JobEnvelope,
  type JobErrorSummary,
  type JobFollowUp,
  type JobHandle,
  type JobsAdapter,
  type JobsAdapterContext,
  type JobsAdapterFactory,
  type ProcessJob,
  type QueueDeclaration,
  type RetryResult,
  type SettleEvent,
  type TransportJob,
  type WorkerOptions,
} from '../contract/index.js';
import { boundedDelay, checkedFollowUps } from '../contract/settle-rules.js';
import { decodeEnvelope } from '../envelope/codec.js';
import { backoffDelay } from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import {
  checkedListOptions,
  checkedPruneOptions,
  compareFailed,
  isAfterCursor,
} from '../failed/list-options.js';
import { retryRefusal } from '../failed/retry-rule.js';
import { checkedBatch } from '../flows/batch-check.js';
import { withCatchFired } from '../flows/chain-advance.js';
import { isFlowId, MAX_CHILD_FAILURES } from '../flows/flow-limits.js';
import { startScheduleTicker, type ScheduleTicker } from '../schedules/ticker.js';
import {
  setLongTimeout,
  systemClock,
  type JobsClock,
  type LongTimer,
} from '../timing/long-timer.js';
import { BatchStore, type RecordedOutcome } from './batch-store.js';
import { LeaseTable } from './lease-table.js';
import { promised } from './promised.js';
import { ScheduleStore } from './schedule-store.js';

/** Options of {@link memoryJobs}. */
export interface MemoryJobsOptions {
  /** The time source; a test passes a virtual clock. Defaults to the system clock. */
  readonly clock?: JobsClock;
}

/** Jobs of one queue by state, for inspection. */
export interface MemoryQueueCounts {
  readonly waiting: number;
  readonly delayed: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  /** Batch finalizers held until every child of their batch has a final outcome. */
  readonly pending: number;
}

type JobState = 'waiting' | 'delayed' | 'pending' | 'active' | 'completed' | 'failed' | 'dropped';

interface StoredJob {
  readonly id: string;
  readonly queue: string;
  readonly sequence: number;
  readonly priority: number;
  /**
   * The envelope as a transport would store it: serialized. Rewritten only to
   * mark a chain step's catch as fired.
   */
  data: string;
  /** The envelope's job name, read once at enqueue. */
  readonly name: string;
  /** The batch membership, read once at enqueue. */
  readonly batch: { readonly id: string; readonly index: number } | undefined;
  readonly attempts: number;
  state: JobState;
  attemptsMade: number;
  unknownReleases: number;
  timer: LongTimer | undefined;
  settledAt: number;
  /** Set when the job failed for the last time: the checked summary, never a raw value. */
  failure: JobErrorSummary | undefined;
}

interface QueueStore {
  readonly declaration: QueueDeclaration;
  /** Waiting jobs, ordered by priority then arrival. */
  readonly waiting: StoredJob[];
  /** Settled jobs in settlement order, oldest first. */
  readonly completed: StoredJob[];
  readonly failed: StoredJob[];
}

/** How a settle ended. */
interface Settled {
  /** The outcome applied: the processor's, or {@link PROCESSOR_BROKE_CONTRACT} for a bad follow-up. */
  readonly outcome: AttemptOutcome;
  readonly final: boolean;
  readonly failedJob: FailedJobRef | undefined;
}

/** What a worker asks of the adapter that owns its jobs. */
interface WorkerHost {
  activate(job: StoredJob): void;
  /** Apply an attempt's outcome to `job` and say whether it was final and where a failure is kept. */
  settle(job: StoredJob, outcome: AttemptOutcome): Settled;
  forget(worker: MemoryWorker): void;
}

interface Delivery {
  readonly job: StoredJob;
  readonly controller: AbortController;
}

/** Surface an error nothing can handle as an uncaught exception, never dropped. */
function surface(error: unknown): void {
  setImmediate(() => {
    throw error;
  });
}

/** A key's entry in the key map: keys deduplicate per queue. */
function keyIdOf(queue: string, key: string): string {
  return `${queue}\u0000${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class MemoryWorker implements AdapterWorker {
  readonly #host: WorkerHost;
  readonly #queues: readonly QueueStore[];
  readonly #concurrency: ReadonlyMap<string, number>;
  readonly #process: ProcessJob;
  readonly #onSettle: ((event: SettleEvent) => void) | undefined;
  readonly #inFlight = new Map<Delivery, Promise<void>>();
  readonly #active = new Map<string, number>();
  #fetching = true;
  #cursor = 0;

  constructor(
    host: WorkerHost,
    queues: readonly QueueStore[],
    concurrency: number | undefined,
    process: ProcessJob,
    onSettle: ((event: SettleEvent) => void) | undefined,
  ) {
    this.#host = host;
    this.#queues = queues;
    this.#concurrency = new Map(
      queues.map((queue) => [queue.declaration.name, concurrency ?? queue.declaration.concurrency]),
    );
    this.#process = process;
    this.#onSettle = onSettle;
  }

  /** Whether this worker is fetching and has a free slot on a queue with a waiting job. */
  canTake(): boolean {
    if (!this.#fetching) return false;
    return this.#queues.some(
      (queue) =>
        queue.waiting.length > 0 &&
        (this.#active.get(queue.declaration.name) ?? 0) <
          (this.#concurrency.get(queue.declaration.name) ?? 0),
    );
  }

  /** Take as many waiting jobs as free slots allow, rotating over the queues. */
  pump(): void {
    if (!this.#fetching) return;
    let idle = 0;
    while (idle < this.#queues.length) {
      const queue = this.#queues[this.#cursor % this.#queues.length]!;
      this.#cursor += 1;
      const name = queue.declaration.name;
      const active = this.#active.get(name) ?? 0;
      const job = active < (this.#concurrency.get(name) ?? 0) ? queue.waiting.shift() : undefined;
      if (job === undefined) {
        idle += 1;
        continue;
      }
      idle = 0;
      this.#deliver(job);
    }
  }

  #deliver(job: StoredJob): void {
    this.#host.activate(job);
    this.#active.set(job.queue, (this.#active.get(job.queue) ?? 0) + 1);
    const delivery: Delivery = { job, controller: new AbortController() };
    const transportJob: TransportJob = Object.freeze({
      id: job.id,
      queue: job.queue,
      envelope: JSON.parse(job.data) as JobEnvelope,
      attemptsMade: job.attemptsMade,
      unknownReleases: job.unknownReleases,
    });
    let outcome: Promise<AttemptOutcome>;
    try {
      // `Promise.resolve` also covers a processor that returns a bare value.
      outcome = Promise.resolve(this.#process(transportJob, delivery.controller.signal));
    } catch {
      outcome = Promise.resolve(PROCESSOR_BROKE_CONTRACT);
    }
    const settled = outcome
      .then(checkedAttemptOutcome, () => PROCESSOR_BROKE_CONTRACT)
      .then((result) => {
        this.#inFlight.delete(delivery);
        this.#active.set(job.queue, (this.#active.get(job.queue) ?? 1) - 1);
        const { outcome: applied, final, failedJob } = this.#host.settle(job, result);
        try {
          this.#onSettle?.({ job: transportJob, outcome: applied, final, failedJob });
        } catch (error) {
          // The job is already settled; a throwing observer is a runtime bug,
          // surfaced as an uncaught exception rather than wedging this worker.
          surface(error);
        }
      });
    this.#inFlight.set(delivery, settled);
  }

  async #stop(abort: boolean): Promise<void> {
    this.#fetching = false;
    if (abort) {
      for (const delivery of this.#inFlight.keys()) {
        delivery.controller.abort(new JobsErrors.Error('worker_aborted'));
      }
    }
    // A job stays held until its processor settles: releasing it earlier
    // would let another worker run it alongside the abandoned attempt.
    await Promise.all(this.#inFlight.values());
    this.#host.forget(this);
  }

  drain(): Promise<void> {
    return this.#stop(false);
  }

  abort(): Promise<void> {
    return this.#stop(true);
  }
}

/** The in-memory {@link JobsAdapter}. */
export class MemoryJobsAdapter implements JobsAdapter {
  readonly name = 'memory';
  readonly reach = 'process';
  readonly capabilities: JobsAdapter['capabilities'];
  readonly #clock: JobsClock;
  readonly #queues = new Map<string, QueueStore>();
  readonly #keys = new Map<string, { readonly id: string; readonly expiresAt: number }>();
  readonly #byId = new Map<string, StoredJob>();
  readonly #delayed = new Set<StoredJob>();
  readonly #pending = new Set<StoredJob>();
  readonly #workers = new Set<MemoryWorker>();
  readonly #active = new Map<string, Set<StoredJob>>();
  readonly #batches = new BatchStore<StoredJob>();
  readonly #schedules: ScheduleStore;
  readonly #host: WorkerHost = {
    activate: (job) => this.#activate(job),
    settle: (job, outcome) => this.#settle(job, outcome),
    forget: (worker) => {
      this.#workers.delete(worker);
      if (this.#workers.size === 0) this.#stopTicker();
      this.#queuePump();
    },
  };
  #ticker: ScheduleTicker | undefined;
  #sequence = 0;
  #nextKeySweep = 0;
  #pumpQueued = false;
  #closed = false;

  constructor(context: JobsAdapterContext, options: MemoryJobsOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    for (const declaration of context.queues) {
      this.#queues.set(declaration.name, { declaration, waiting: [], completed: [], failed: [] });
    }
    this.#schedules = new ScheduleStore({
      now: () => this.#clock.now(),
      hasQueue: (queue) => this.#queues.has(queue),
      store: (queue, envelope) => {
        this.#store(queue, envelope, false);
      },
    });
    const flows: FlowTransport = {
      enqueueBatch: (batch) => promised(() => this.#enqueueBatch(batch)),
      batchStatus: (id) =>
        promised(() => {
          this.#batches.sweep(this.#clock.now());
          return isFlowId(id) ? this.#batches.status(id) : undefined;
        }),
      childFailures: (id, limit) =>
        promised(() => {
          if (
            typeof limit !== 'number' ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > MAX_CHILD_FAILURES
          ) {
            throw new JobsErrors.Error('invalid_option', { option: 'limit' });
          }
          return isFlowId(id) ? this.#batches.failures(id, limit) : Object.freeze([]);
        }),
    };
    const failedJobs: FailedJobsCapability = {
      list: (listOptions) => promised(() => this.#listFailed(listOptions)),
      get: (id) => promised(() => this.#failedJob(id)),
      retry: (id, retryOptions) => promised(() => this.#retry(id, retryOptions)),
      remove: (id) => promised(() => this.#removeFailed(id)),
      prune: (pruneOptions) => promised(() => this.#prune(pruneOptions)),
    };
    this.capabilities = Object.freeze({
      flows: Object.freeze(flows),
      failedJobs: Object.freeze(failedJobs),
      schedules: this.#schedules,
      leases: new LeaseTable(this.#clock),
    });
  }

  /**
   * @throws (as a rejection) `jobs.invalid_envelope` for a value that is not a
   *   current-version envelope: this transport serves one process, so its
   *   producer always writes the version its workers read.
   */
  enqueue(queue: string, value: JobEnvelope): Promise<JobHandle> {
    if (this.#closed) return Promise.reject(new JobsErrors.Error('adapter_closed'));
    if (!this.#queues.has(queue)) return Promise.reject(new JobsErrors.Error('unknown_queue'));
    const decoded = decodeEnvelope(value);
    if (!decoded.ok) return Promise.reject(new JobsErrors.Error('invalid_envelope'));
    return Promise.resolve(this.#store(queue, decoded.envelope, false).handle);
  }

  /**
   * Store a decoded envelope on a declared queue: runnable from its run time,
   * or held for its batch (`held`). A key taken inside its window stores
   * nothing and hands back the first job's id.
   */
  #store(
    queue: string,
    envelope: JobEnvelope,
    held: boolean,
  ): { readonly handle: JobHandle; readonly job: StoredJob | undefined } {
    const now = this.#clock.now();
    this.#sweepKeys(now);
    const { key, keyWindowMs, runAt, flow } = envelope.meta;
    const taken = this.#heldKey(queue, key, now);
    if (taken !== undefined) {
      return { handle: Object.freeze({ id: taken, deduplicated: true }), job: undefined };
    }
    this.#sequence += 1;
    const job: StoredJob = {
      id: String(this.#sequence),
      queue,
      sequence: this.#sequence,
      priority: envelope.options.priority ?? 0,
      data: JSON.stringify(envelope),
      name: envelope.name,
      batch: flow?.kind === 'batch' ? { id: flow.id, index: flow.index } : undefined,
      attempts: envelope.options.attempts ?? 1,
      state: 'waiting',
      attemptsMade: 0,
      unknownReleases: 0,
      timer: undefined,
      settledAt: 0,
      failure: undefined,
    };
    this.#byId.set(job.id, job);
    if (key !== undefined) {
      this.#keys.set(keyIdOf(queue, key), { id: job.id, expiresAt: now + (keyWindowMs ?? 0) });
    }
    if (held) {
      job.state = 'pending';
      this.#pending.add(job);
    } else {
      this.#schedule(job, runAt === undefined ? 0 : boundedDelay(runAt - now));
    }
    return { handle: Object.freeze({ id: job.id, deduplicated: false }), job };
  }

  /** The id of the job holding `key` on `queue` inside its window, if any. */
  #heldKey(queue: string, key: string | undefined, now: number): string | undefined {
    if (key === undefined) return undefined;
    const held = this.#keys.get(keyIdOf(queue, key));
    return held !== undefined && held.expiresAt > now ? held.id : undefined;
  }

  /** Check a whole batch, then store its finalizer (held) and its children in one step. */
  #enqueueBatch(batch: BatchEnqueue): { readonly deduplicated: boolean } {
    if (this.#closed) throw new JobsErrors.Error('adapter_closed');
    const { id, children, finalizer } = checkedBatch(batch, (queue) => this.#queues.has(queue));
    const now = this.#clock.now();
    this.#batches.sweep(now);
    this.#sweepKeys(now);
    // A new batch whose child key is already taken would leave that child
    // unstored and the batch unsettled for good, so it is refused whole.
    if (
      this.#batches.status(id) === undefined &&
      children.some((child) => this.#heldKey(child.queue, child.envelope.meta.key, now))
    ) {
      throw new JobsErrors.Error('flow_conflict');
    }
    const created = this.#batches.create(id, children.length, () => {
      const stored = this.#store(finalizer.queue, finalizer.envelope, true).job;
      // A finalizer has no key, so it is always stored.
      return stored!;
    });
    if (created === 'conflict') throw new JobsErrors.Error('flow_conflict');
    if (created === 'exists') return Object.freeze({ deduplicated: true });
    for (const child of children) this.#store(child.queue, child.envelope, false);
    return Object.freeze({ deduplicated: false });
  }

  startWorker(options: WorkerOptions, process: ProcessJob): Promise<AdapterWorker> {
    if (this.#closed) return Promise.reject(new JobsErrors.Error('adapter_closed'));
    if (options.queues.length === 0) {
      return Promise.reject(new JobsErrors.Error('invalid_worker', { option: 'queues' }));
    }
    if (
      options.concurrency !== undefined &&
      (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    ) {
      return Promise.reject(new JobsErrors.Error('invalid_worker', { option: 'concurrency' }));
    }
    const queues: QueueStore[] = [];
    for (const name of new Set(options.queues)) {
      const store = this.#queues.get(name);
      if (store === undefined) return Promise.reject(new JobsErrors.Error('unknown_queue'));
      queues.push(store);
    }
    const worker = new MemoryWorker(
      this.#host,
      queues,
      options.concurrency,
      process,
      options.onSettle,
    );
    this.#workers.add(worker);
    this.#ticker ??= startScheduleTicker(this.#schedules.port, this.#clock, surface);
    this.#queuePump();
    return Promise.resolve(worker);
  }

  #stopTicker(): void {
    this.#ticker?.stop();
    this.#ticker = undefined;
  }

  /**
   * Stop every worker as `abort()` does and wait for them. Delayed jobs keep
   * their state with their timers cancelled, so nothing runs after close.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#stopTicker();
    for (const job of this.#delayed) {
      job.timer?.cancel();
      job.timer = undefined;
    }
    await Promise.all([...this.#workers].map((worker) => worker.abort()));
  }

  /** Jobs of `queue` by state. */
  counts(queue: string): MemoryQueueCounts {
    const store = this.#queues.get(queue);
    if (store === undefined) throw new JobsErrors.Error('unknown_queue');
    const now = this.#clock.now();
    this.#evict(store, 'completed', now);
    this.#evict(store, 'failed', now);
    let delayed = 0;
    for (const job of this.#delayed) if (job.queue === queue) delayed += 1;
    return Object.freeze({
      waiting: store.waiting.length,
      delayed,
      active: this.#active.get(queue)?.size ?? 0,
      completed: store.completed.length,
      failed: store.failed.length,
      pending: [...this.#pending].filter((job) => job.queue === queue).length,
    });
  }

  /**
   * Test hook: deliver a retained completed or failed job again under the
   * same id with the same stored envelope, as a shared transport does after
   * a lost lock. Its attempt count is kept and its failure record cleared.
   * False for any other job (waiting, delayed, pending, active, or no longer
   * held).
   */
  redeliver(id: string): boolean {
    const job = this.#byId.get(id);
    if (job === undefined || (job.state !== 'completed' && job.state !== 'failed')) return false;
    const store = this.#queues.get(job.queue)!;
    const list = job.state === 'completed' ? store.completed : store.failed;
    list.splice(list.indexOf(job), 1);
    job.failure = undefined;
    this.#schedule(job, 0);
    return true;
  }

  /** Test hook: drop every retained completed job of `queue` now; returns how many. */
  evictCompleted(queue: string): number {
    const store = this.#queues.get(queue);
    if (store === undefined) throw new JobsErrors.Error('unknown_queue');
    const evicted = store.completed.splice(0);
    for (const job of evicted) this.#byId.delete(job.id);
    return evicted.length;
  }

  #toFailedJob(job: StoredJob): FailedJob {
    return Object.freeze({
      id: job.id,
      queue: job.queue,
      envelope: JSON.parse(job.data) as JobEnvelope,
      error: job.failure!,
      failedAt: job.settledAt,
    });
  }

  /** The job `id` when it is in its queue's failed list after retention ran. */
  #failedById(id: unknown): StoredJob | undefined {
    if (typeof id !== 'string') return undefined;
    const job = this.#byId.get(id);
    if (job === undefined) return undefined;
    this.#evict(this.#queues.get(job.queue)!, 'failed', this.#clock.now());
    return job.state === 'failed' && this.#byId.has(id) ? job : undefined;
  }

  #listFailed(options: unknown): readonly FailedJob[] {
    const { queue, limit, before } = checkedListOptions(options);
    let stores = [...this.#queues.values()];
    if (queue !== undefined) {
      const store = this.#queues.get(queue);
      if (store === undefined) throw new JobsErrors.Error('unknown_queue');
      stores = [store];
    }
    const now = this.#clock.now();
    const jobs: StoredJob[] = [];
    for (const store of stores) {
      this.#evict(store, 'failed', now);
      jobs.push(...store.failed);
    }
    const ordered = jobs
      .map((job) => ({ job, failedAt: job.settledAt, id: job.id }))
      .filter((entry) => before === undefined || isAfterCursor(entry.failedAt, entry.id, before))
      .sort(compareFailed);
    return Object.freeze(ordered.slice(0, limit).map((entry) => this.#toFailedJob(entry.job)));
  }

  #failedJob(id: string): FailedJob | undefined {
    const job = this.#failedById(id);
    return job === undefined ? undefined : this.#toFailedJob(job);
  }

  #retry(id: string, options: unknown): RetryResult {
    if (options !== undefined) {
      if (!isRecord(options) || Object.keys(options).some((key) => key !== 'force')) {
        throw new JobsErrors.Error('invalid_option', { option: 'options' });
      }
      if (options.force !== undefined && typeof options.force !== 'boolean') {
        throw new JobsErrors.Error('invalid_option', { option: 'force' });
      }
    }
    const force = isRecord(options) && options.force === true;
    if (typeof id !== 'string' || !this.#byId.has(id)) return 'not_found';
    const job = this.#failedById(id);
    if (job === undefined) return this.#byId.has(id) ? 'not_failed' : 'not_found';
    if (retryRefusal(JSON.parse(job.data), force) !== undefined) return 'not_retryable';
    const store = this.#queues.get(job.queue)!;
    store.failed.splice(store.failed.indexOf(job), 1);
    job.failure = undefined;
    job.attemptsMade = 0;
    job.unknownReleases = 0;
    if (job.batch !== undefined) this.#batches.retried(job.batch.id, job.batch.index);
    this.#schedule(job, 0);
    return 'retried';
  }

  #removeFailed(id: string): boolean {
    const job = this.#failedById(id);
    if (job === undefined) return false;
    const store = this.#queues.get(job.queue)!;
    store.failed.splice(store.failed.indexOf(job), 1);
    job.state = 'dropped';
    this.#byId.delete(job.id);
    return true;
  }

  #prune(options: unknown): number {
    const cutoff = this.#clock.now() - checkedPruneOptions(options);
    let pruned = 0;
    for (const store of this.#queues.values()) {
      for (const job of store.failed.filter((candidate) => candidate.settledAt < cutoff)) {
        store.failed.splice(store.failed.indexOf(job), 1);
        job.state = 'dropped';
        this.#byId.delete(job.id);
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Whether an attempt is in flight or a running worker has a job it could take now. */
  busy(): boolean {
    for (const set of this.#active.values()) if (set.size > 0) return true;
    for (const worker of this.#workers) if (worker.canTake()) return true;
    return false;
  }

  /**
   * Put `job` in its queue now, or after `delayMs`. On a closed adapter the
   * job takes the same state with no timer and no wake-up: nothing runs any
   * more, and the store still holds it.
   */
  #schedule(job: StoredJob, delayMs: number): void {
    if (this.#closed) {
      if (delayMs <= 0) {
        job.state = 'waiting';
        this.#insertWaiting(job);
      } else {
        job.state = 'delayed';
        this.#delayed.add(job);
      }
      return;
    }
    if (delayMs <= 0) {
      job.state = 'waiting';
      this.#insertWaiting(job);
      this.#queuePump();
      return;
    }
    job.state = 'delayed';
    this.#delayed.add(job);
    job.timer = setLongTimeout(
      () => {
        job.timer = undefined;
        this.#delayed.delete(job);
        job.state = 'waiting';
        this.#insertWaiting(job);
        this.#queuePump();
      },
      delayMs,
      this.#clock,
    );
  }

  #insertWaiting(job: StoredJob): void {
    const waiting = this.#queues.get(job.queue)!.waiting;
    let low = 0;
    let high = waiting.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = waiting[middle]!;
      const before =
        other.priority < job.priority ||
        (other.priority === job.priority && other.sequence < job.sequence);
      if (before) low = middle + 1;
      else high = middle;
    }
    waiting.splice(low, 0, job);
  }

  /** Coalesce wake-ups into one pass, after the current call returns. */
  #queuePump(): void {
    if (this.#pumpQueued) return;
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      for (const worker of this.#workers) worker.pump();
    });
  }

  /** Drop expired keys, at most once per second of clock time. */
  #sweepKeys(now: number): void {
    if (now < this.#nextKeySweep) return;
    this.#nextKeySweep = now + 1_000;
    for (const [id, held] of this.#keys) if (held.expiresAt <= now) this.#keys.delete(id);
  }

  #activate(job: StoredJob): void {
    job.state = 'active';
    let set = this.#active.get(job.queue);
    if (set === undefined) {
      set = new Set();
      this.#active.set(job.queue, set);
    }
    set.add(job);
  }

  #storeFollowUps(followUps: readonly JobFollowUp[]): void {
    for (const { queue, envelope } of followUps) this.#store(queue, envelope, false);
  }

  #settle(job: StoredJob, processed: AttemptOutcome): Settled {
    this.#active.get(job.queue)?.delete(job);
    const now = this.#clock.now();
    let outcome = processed;
    let followUps = checkedFollowUps(outcome, job.attemptsMade, job.attempts, (queue) =>
      this.#queues.has(queue),
    );
    if (followUps === undefined) {
      outcome = PROCESSOR_BROKE_CONTRACT;
      followUps = [];
    }
    let result: Settled;
    switch (outcome.kind) {
      case 'completed':
      case 'discarded':
      case 'skipped':
        this.#retain(job, 'completed', now);
        this.#recordChild(job, { kind: outcome.kind === 'skipped' ? 'skipped' : 'completed' }, now);
        this.#storeFollowUps(followUps);
        result = { outcome, final: true, failedJob: undefined };
        break;
      case 'released':
        if (outcome.reason === 'unknown_job') job.unknownReleases += 1;
        this.#schedule(job, boundedDelay(outcome.delayMs));
        result = { outcome, final: false, failedJob: undefined };
        break;
      case 'failed': {
        const final = isFinalFailure(job.attemptsMade, job.attempts, outcome.retryable);
        job.attemptsMade += 1;
        if (!final) {
          this.#schedule(job, backoffDelay(this.#backoffOf(job), job.attemptsMade));
          result = { outcome, final: false, failedJob: undefined };
          break;
        }
        this.#recordChild(job, { kind: 'failed', name: job.name, error: outcome.error }, now);
        this.#storeFollowUps(followUps);
        if (outcome.catchFired === true) this.#markCatchFired(job);
        if (outcome.drop === true) {
          job.state = 'dropped';
          this.#byId.delete(job.id);
          result = { outcome, final: true, failedJob: undefined };
          break;
        }
        job.failure = outcome.error;
        this.#retain(job, 'failed', now);
        // Retention may evict the job in the same step (a failed count of 0):
        // then no failed job exists to point at.
        const kept = this.#byId.has(job.id);
        result = {
          outcome,
          final: true,
          failedJob: kept ? Object.freeze({ id: job.id, queue: job.queue }) : undefined,
        };
        break;
      }
    }
    this.#queuePump();
    return result;
  }

  /** Record a batch child's final outcome; the record that settles its batch releases the finalizer. */
  #recordChild(job: StoredJob, outcome: RecordedOutcome, now: number): void {
    if (job.batch === undefined) return;
    const finalizer = this.#batches.record(job.batch.id, job.batch.index, outcome, now);
    if (finalizer === undefined || !this.#pending.delete(finalizer)) return;
    this.#schedule(finalizer, 0);
  }

  /**
   * Mark a chain step's stored envelope as having fired its catch. A
   * processor that flags a job that is no chain step broke the contract; the
   * flag means nothing for such a job and is ignored.
   */
  #markCatchFired(job: StoredJob): void {
    const decoded = decodeEnvelope(JSON.parse(job.data));
    if (!decoded.ok || decoded.envelope.meta.flow?.kind !== 'chain') return;
    job.data = JSON.stringify(withCatchFired(decoded.envelope));
  }

  #backoffOf(job: StoredJob): JobEnvelope['options']['backoff'] {
    return (JSON.parse(job.data) as JobEnvelope).options.backoff;
  }

  #retain(job: StoredJob, state: 'completed' | 'failed', now: number): void {
    job.state = state;
    job.settledAt = now;
    const store = this.#queues.get(job.queue)!;
    (state === 'completed' ? store.completed : store.failed).push(job);
    this.#evict(store, 'completed', now);
    this.#evict(store, 'failed', now);
  }

  /**
   * Apply a retention rule. Eviction runs when a job settles and when counts
   * are read, so an aged-out job is never reported, though a queue that sees
   * neither keeps it in memory until then.
   */
  #evict(store: QueueStore, state: 'completed' | 'failed', now: number): void {
    const list = state === 'completed' ? store.completed : store.failed;
    const rule = store.declaration.retention[state];
    while (list.length > rule.count || (list.length > 0 && now - list[0]!.settledAt > rule.ageMs)) {
      this.#byId.delete(list.shift()!.id);
    }
  }
}

/** The memory adapter factory for `jobs({ adapter })`. */
export function memoryJobs(options: MemoryJobsOptions = {}): JobsAdapterFactory {
  return (context) => new MemoryJobsAdapter(context, options);
}
