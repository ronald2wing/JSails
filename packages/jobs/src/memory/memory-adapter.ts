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
 *   so a job never runs alongside an attempt of itself;
 * - settled jobs are kept per the queue's retention, the failed ones being
 *   the failed-job list.
 *
 * Every delivery hands the processor a fresh copy of the stored envelope, as
 * a serializing transport does, so a handler that mutates its payload cannot
 * change what a later attempt sees.
 */

import { JsailsError } from 'jsails/support';

import type {
  AdapterWorker,
  AttemptOutcome,
  JobEnvelope,
  JobHandle,
  JobsAdapter,
  JobsAdapterContext,
  JobsAdapterFactory,
  ProcessJob,
  QueueDeclaration,
  SettleEvent,
  TransportJob,
  WorkerOptions,
} from '../contract/index.js';
import { decodeEnvelope } from '../envelope/codec.js';
import { backoffDelay, MAX_JOB_DELAY_MS } from '../envelope/job-options.js';
import {
  setLongTimeout,
  systemClock,
  type JobsClock,
  type LongTimer,
} from '../timing/long-timer.js';

export type MemoryJobsErrorCode =
  'unknown_queue' | 'invalid_envelope' | 'adapter_closed' | 'invalid_worker' | 'worker_aborted';

/** Raised by the memory adapter. Value-free. */
export class MemoryJobsError extends JsailsError {
  constructor(
    readonly code: MemoryJobsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

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
}

type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';

interface StoredJob {
  readonly id: string;
  readonly queue: string;
  readonly sequence: number;
  readonly priority: number;
  /** The envelope as a transport would store it: serialized. */
  readonly data: string;
  readonly attempts: number;
  state: JobState;
  attemptsMade: number;
  unknownReleases: number;
  timer: LongTimer | undefined;
  settledAt: number;
}

interface QueueStore {
  readonly declaration: QueueDeclaration;
  /** Waiting jobs, ordered by priority then arrival. */
  readonly waiting: StoredJob[];
  /** Settled jobs in settlement order, oldest first. */
  readonly completed: StoredJob[];
  readonly failed: StoredJob[];
}

/** What a worker asks of the adapter that owns its jobs. */
interface WorkerHost {
  activate(job: StoredJob): void;
  /** Apply an attempt's outcome to `job` and return whether it was final. */
  settle(job: StoredJob, outcome: AttemptOutcome): boolean;
  forget(worker: MemoryWorker): void;
}

interface Delivery {
  readonly job: StoredJob;
  readonly controller: AbortController;
}

const PROCESSOR_BROKE_CONTRACT: AttemptOutcome = Object.freeze({
  kind: 'failed',
  error: Object.freeze({ kind: 'internal', name: 'ProcessorRejected' }),
  retryable: true,
});

const OUTCOME_KINDS: ReadonlySet<string> = new Set([
  'completed',
  'discarded',
  'skipped',
  'released',
  'failed',
]);

/**
 * The outcome a processor resolved with, or {@link PROCESSOR_BROKE_CONTRACT}
 * for anything that is not one: an unknown kind would otherwise leave the job
 * neither waiting nor settled, lost to every worker.
 */
function checkedOutcome(value: unknown): AttemptOutcome {
  return typeof value === 'object' &&
    value !== null &&
    OUTCOME_KINDS.has((value as { kind?: unknown }).kind as string)
    ? (value as AttemptOutcome)
    : PROCESSOR_BROKE_CONTRACT;
}

/**
 * A wait the long timer accepts: a whole number of milliseconds from 0 to one
 * year. A processor's release delay is not trusted to be one; a fraction is
 * rounded up so a job never runs early.
 */
function boundedDelay(ms: number | undefined): number {
  if (ms === undefined || Number.isNaN(ms) || ms <= 0) return 0;
  return Math.min(Math.ceil(ms), MAX_JOB_DELAY_MS);
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
      .then(checkedOutcome, () => PROCESSOR_BROKE_CONTRACT)
      .then((result) => {
        this.#inFlight.delete(delivery);
        this.#active.set(job.queue, (this.#active.get(job.queue) ?? 1) - 1);
        const final = this.#host.settle(job, result);
        try {
          this.#onSettle?.({ job: transportJob, outcome: result, final });
        } catch (error) {
          // The job is already settled; a throwing observer is a runtime bug,
          // surfaced as an uncaught exception rather than wedging this worker.
          setImmediate(() => {
            throw error;
          });
        }
      });
    this.#inFlight.set(delivery, settled);
  }

  async #stop(abort: boolean): Promise<void> {
    this.#fetching = false;
    if (abort) {
      for (const delivery of this.#inFlight.keys()) {
        delivery.controller.abort(
          new MemoryJobsError('worker_aborted', 'the worker is shutting down'),
        );
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
  readonly capabilities: JobsAdapter['capabilities'] = Object.freeze({});
  readonly #clock: JobsClock;
  readonly #queues = new Map<string, QueueStore>();
  readonly #keys = new Map<string, { readonly id: string; readonly expiresAt: number }>();
  readonly #delayed = new Set<StoredJob>();
  readonly #workers = new Set<MemoryWorker>();
  readonly #active = new Map<string, Set<StoredJob>>();
  readonly #host: WorkerHost = {
    activate: (job) => this.#activate(job),
    settle: (job, outcome) => this.#settle(job, outcome),
    forget: (worker) => {
      this.#workers.delete(worker);
      this.#queuePump();
    },
  };
  #sequence = 0;
  #nextKeySweep = 0;
  #pumpQueued = false;
  #closed = false;

  constructor(context: JobsAdapterContext, options: MemoryJobsOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    for (const declaration of context.queues) {
      this.#queues.set(declaration.name, { declaration, waiting: [], completed: [], failed: [] });
    }
  }

  /**
   * @throws {MemoryJobsError} (as a rejection) `invalid_envelope` for a value
   *   that is not a current-version envelope: this transport serves one
   *   process, so its producer always writes the version its workers read.
   */
  enqueue(queue: string, value: JobEnvelope): Promise<JobHandle> {
    if (this.#closed)
      return Promise.reject(new MemoryJobsError('adapter_closed', 'the memory adapter is closed'));
    const store = this.#queues.get(queue);
    if (store === undefined) {
      return Promise.reject(new MemoryJobsError('unknown_queue', 'the queue is not declared'));
    }
    const decoded = decodeEnvelope(value);
    if (!decoded.ok) {
      return Promise.reject(
        new MemoryJobsError(
          'invalid_envelope',
          'the value is not a job envelope this adapter reads',
        ),
      );
    }
    const envelope = decoded.envelope;
    const now = this.#clock.now();
    this.#sweepKeys(now);
    const { key, keyWindowMs, runAt } = envelope.meta;
    const keyId = key === undefined ? undefined : `${queue}\u0000${key}`;
    if (keyId !== undefined) {
      const held = this.#keys.get(keyId);
      if (held !== undefined && held.expiresAt > now) {
        return Promise.resolve(Object.freeze({ id: held.id, deduplicated: true }));
      }
    }
    this.#sequence += 1;
    const job: StoredJob = {
      id: String(this.#sequence),
      queue,
      sequence: this.#sequence,
      priority: envelope.options.priority ?? 0,
      data: JSON.stringify(envelope),
      attempts: envelope.options.attempts ?? 1,
      state: 'waiting',
      attemptsMade: 0,
      unknownReleases: 0,
      timer: undefined,
      settledAt: 0,
    };
    if (keyId !== undefined) {
      this.#keys.set(keyId, { id: job.id, expiresAt: now + (keyWindowMs ?? 0) });
    }
    this.#schedule(job, runAt === undefined ? 0 : boundedDelay(runAt - now));
    return Promise.resolve(Object.freeze({ id: job.id, deduplicated: false }));
  }

  startWorker(options: WorkerOptions, process: ProcessJob): Promise<AdapterWorker> {
    if (this.#closed)
      return Promise.reject(new MemoryJobsError('adapter_closed', 'the memory adapter is closed'));
    if (options.queues.length === 0) {
      return Promise.reject(
        new MemoryJobsError('invalid_worker', 'a worker needs at least one queue'),
      );
    }
    if (
      options.concurrency !== undefined &&
      (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    ) {
      return Promise.reject(
        new MemoryJobsError('invalid_worker', 'worker concurrency must be a positive integer'),
      );
    }
    const queues: QueueStore[] = [];
    for (const name of new Set(options.queues)) {
      const store = this.#queues.get(name);
      if (store === undefined) {
        return Promise.reject(new MemoryJobsError('unknown_queue', 'the queue is not declared'));
      }
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
    this.#queuePump();
    return Promise.resolve(worker);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#workers].map((worker) => worker.abort()));
    for (const job of this.#delayed) job.timer?.cancel();
    this.#delayed.clear();
  }

  /** Jobs of `queue` by state. */
  counts(queue: string): MemoryQueueCounts {
    const store = this.#queues.get(queue);
    if (store === undefined)
      throw new MemoryJobsError('unknown_queue', 'the queue is not declared');
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
    });
  }

  /** Whether an attempt is in flight or a running worker has a job it could take now. */
  busy(): boolean {
    for (const set of this.#active.values()) if (set.size > 0) return true;
    for (const worker of this.#workers) if (worker.canTake()) return true;
    return false;
  }

  /** Put `job` in its queue now, or after `delayMs`. */
  #schedule(job: StoredJob, delayMs: number): void {
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
        if (this.#closed) return;
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

  #settle(job: StoredJob, outcome: AttemptOutcome): boolean {
    this.#active.get(job.queue)?.delete(job);
    const now = this.#clock.now();
    let final: boolean;
    switch (outcome.kind) {
      case 'completed':
      case 'discarded':
      case 'skipped':
        this.#retain(job, 'completed', now);
        final = true;
        break;
      case 'released':
        if (outcome.reason === 'unknown_job') job.unknownReleases += 1;
        if (!this.#closed) this.#schedule(job, boundedDelay(outcome.delayMs));
        final = false;
        break;
      case 'failed':
        job.attemptsMade += 1;
        if (outcome.retryable && job.attemptsMade < job.attempts) {
          if (!this.#closed)
            this.#schedule(job, backoffDelay(this.#backoffOf(job), job.attemptsMade));
          final = false;
        } else {
          this.#retain(job, 'failed', now);
          final = true;
        }
        break;
    }
    this.#queuePump();
    return final;
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
    while (list.length > rule.count) list.shift();
    while (list.length > 0 && now - list[0]!.settledAt > rule.ageMs) list.shift();
  }
}

/** The memory adapter factory for `jobs({ adapter })`. */
export function memoryJobs(options: MemoryJobsOptions = {}): JobsAdapterFactory {
  return (context) => new MemoryJobsAdapter(context, options);
}
