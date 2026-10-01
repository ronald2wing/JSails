/**
 * A reference model of the jobs contract, small enough to read in one sitting,
 * that passes every conformance scenario. It exists to prove the scenarios are
 * satisfiable and assert what the contract says, so a scenario that fails on
 * the legacy driver fails because of the legacy code, not because the
 * scenario is wrong. It is not an adapter: it has no persistence, no
 * concurrency beyond one event loop, and no performance goals.
 *
 * Everything a transport would persist (jobs, keys, chains, batches, failed
 * jobs, schedules) lives in one in-memory store that survives a producer
 * restart. The rules it implements are the contract's:
 *
 * - a key deduplicates for its window regardless of the first job's state;
 * - every attempt gets its own copy of the stored payload, as from a
 *   transport that serializes it;
 * - an aborted attempt is released (no attempt spent) once its handler
 *   rejects, or completed when the handler returns anyway (its effect
 *   happened), and its job stays held until then, so it never runs twice at
 *   once;
 * - abort and drain return in bounded time whatever handlers do;
 * - chain advances, a chain's catch and batch callbacks are keyed enqueues,
 *   so a redelivery cannot fork a chain or re-fire a callback;
 * - a chain's catch fires once, when a step fails for good, and marks the
 *   step, which is then retried only when forced;
 * - a batch validates every item before enqueueing any, and a child retried
 *   after the batch settled is counted and fires nothing;
 * - a retry re-runs the same envelope, flow membership included;
 * - a worker that does not know a job releases it with a delay;
 * - schedules keep their pause state across reconcile, a resume skips the
 *   fire times missed while paused, and a cron schedule fires on the
 *   package's evaluator (pinned independently by `CRON_FIRE_CASES`).
 */

import {
  JOB_ENVELOPE_VERSION,
  type BatchStatus,
  type FailedJob,
  type JobHandle,
  type RetryResult,
} from '../../src/index.js';
import { nextCronFire, parseCron } from '../../src/schedules/cron.js';
import { canonicalTimeZone } from '../../src/schedules/time-zone.js';
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

const DEFAULT_KEY_WINDOW_MS = 86_400_000;
const UNKNOWN_RELEASE_MS = 50;
const MAX_UNKNOWN_RELEASES = 10;
const ABORT_GRACE_MS = 100;
const SETTLE_BOUND_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

type Flow =
  | { readonly kind: 'chain'; readonly id: string; readonly step: number }
  | { readonly kind: 'batch'; readonly id: string; readonly index: number };

interface StoredJob {
  readonly id: string;
  readonly call: ScenarioCall;
  readonly tags: readonly string[] | undefined;
  readonly flow: Flow | undefined;
  readonly dispatchedAt: number;
  state: 'waiting' | 'active' | 'completed' | 'failed';
  /** Set when this chain step's catch fired. */
  catchFired: boolean;
  runAt: number;
  attemptsMade: number;
  unknownCount: number;
}

interface Attempt {
  readonly job: StoredJob;
  readonly controller: AbortController;
  /**
   * Set when the worker aborted it. A handler that still returns is
   * `completed` (its effect happened); one that rejects is `released`.
   */
  aborted: boolean;
  readonly settled: Promise<void>;
}

interface Worker {
  readonly handle: WorkerHandle;
  readonly knows: ReadonlySet<string> | undefined;
  readonly concurrency: number;
  readonly attempts: Set<Attempt>;
  fetching: boolean;
}

interface Batch {
  readonly total: number;
  readonly callbacks: ScenarioBatchCallbacks;
  readonly recorded: Map<number, 'completed' | 'failed'>;
  settled: boolean;
  retriedAfterSettlement: number;
}

interface Chain {
  readonly steps: readonly ScenarioCall[];
  readonly catch: ScenarioCall | undefined;
}

interface Schedule {
  spec: ScenarioSchedule;
  nextAt: number;
  paused: boolean;
}

/** The first fire time of `spec` strictly after `after`. */
function nextFire(spec: ScenarioSchedule, after: number): number {
  if ('everyMs' in spec) return after + spec.everyMs;
  const parsed = parseCron(spec.cron);
  const tz = canonicalTimeZone(spec.timezone ?? 'UTC');
  if (!parsed.ok || tz === undefined) throw new Error(`invalid cron schedule ${spec.id}`);
  return nextCronFire(parsed.spec, after, tz);
}

interface Timer {
  readonly at: number;
  readonly fire: () => void;
}

class ReferenceDriver implements JobsHarnessDriver {
  readonly #options: DriverOptions;
  readonly #definitions = new Map<string, ScenarioJob>();
  readonly #jobs = new Map<string, StoredJob>();
  readonly #keys = new Map<string, { readonly id: string; readonly expiresAt: number }>();
  readonly #chains = new Map<string, Chain>();
  readonly #batches = new Map<string, Batch>();
  readonly #failed = new Set<string>();
  readonly #leases = new Map<string, string>();
  readonly #schedules = new Map<string, Schedule>();
  readonly #workers = new Map<string, Worker>();
  readonly #events: JobEvent[] = [];
  readonly #timers: Timer[] = [];
  readonly #realTimers = new Set<ReturnType<typeof setTimeout>>();
  #virtualNow = 0;
  #sequence = 0;
  /** When the one pending wake-up for delayed or released jobs fires, if armed. */
  #wakeAt: number | undefined;

  constructor(options: DriverOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.virtualTime ? this.#virtualNow : Date.now();
  }

  #later(ms: number, fire: () => void): void {
    if (this.#options.virtualTime) {
      this.#timers.push({ at: this.#virtualNow + ms, fire });
      return;
    }
    const timer = setTimeout(() => {
      this.#realTimers.delete(timer);
      fire();
    }, ms);
    this.#realTimers.add(timer);
  }

  #id(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }

  define(jobs: readonly ScenarioJob[]): void {
    for (const job of jobs) this.#definitions.set(job.name, job);
  }

  #validate(call: ScenarioCall): void {
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) throw new Error(`unknown job ${call.name}`);
    if (definition.accepts !== undefined && !definition.accepts(call.payload)) {
      throw new Error(`invalid payload for ${call.name}`);
    }
  }

  #enqueue(
    call: ScenarioCall,
    options: ScenarioDispatchOptions,
    flow: Flow | undefined,
  ): JobHandle {
    this.#validate(call);
    const now = this.#now();
    if (options.key !== undefined) {
      const held = this.#keys.get(options.key);
      if (held !== undefined && held.expiresAt > now) return { id: held.id, deduplicated: true };
    }
    const job: StoredJob = {
      id: this.#id('job'),
      call,
      tags: options.tags,
      flow,
      dispatchedAt: now,
      state: 'waiting',
      runAt: now + (options.delayMs ?? 0),
      attemptsMade: 0,
      unknownCount: 0,
      catchFired: false,
    };
    this.#jobs.set(job.id, job);
    if (options.key !== undefined) {
      this.#keys.set(options.key, {
        id: job.id,
        expiresAt: now + (options.keyWindowMs ?? DEFAULT_KEY_WINDOW_MS),
      });
    }
    this.#pump();
    return { id: job.id, deduplicated: false };
  }

  dispatch(call: ScenarioCall, options: ScenarioDispatchOptions = {}): Promise<JobHandle> {
    try {
      return Promise.resolve(this.#enqueue(call, options, undefined));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  chain(
    steps: readonly ScenarioCall[],
    options: { readonly catch?: ScenarioCall } = {},
  ): Promise<JobHandle> {
    try {
      steps.forEach((step) => this.#validate(step));
      if (options.catch !== undefined) this.#validate(options.catch);
      const id = this.#id('chain');
      this.#chains.set(id, { steps, catch: options.catch });
      return Promise.resolve(
        this.#enqueue(steps[0]!, { key: `chain:${id}:0` }, { kind: 'chain', id, step: 0 }),
      );
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  batch(
    items: readonly ScenarioCall[],
    callbacks: ScenarioBatchCallbacks,
  ): Promise<{ readonly id: string }> {
    try {
      items.forEach((item) => this.#validate(item));
      const id = this.#id('batch');
      this.#batches.set(id, {
        total: items.length,
        callbacks,
        recorded: new Map(),
        settled: false,
        retriedAfterSettlement: 0,
      });
      items.forEach((item, index) => {
        this.#enqueue(item, { key: `batch:${id}:${index}` }, { kind: 'batch', id, index });
      });
      return Promise.resolve({ id });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  batchStatus(id: string): Promise<BatchStatus | undefined> {
    const batch = this.#batches.get(id);
    if (batch === undefined) return Promise.resolve(undefined);
    const outcomes = [...batch.recorded.values()];
    const completed = outcomes.filter((outcome) => outcome === 'completed').length;
    const failed = outcomes.length - completed;
    return Promise.resolve({
      total: batch.total,
      completed,
      failed,
      skipped: 0,
      pending: batch.total - outcomes.length,
      settled: batch.settled,
      retriedAfterSettlement: batch.retriedAfterSettlement,
    });
  }

  startWorker(options: StartWorkerOptions = {}): Promise<WorkerHandle> {
    const handle: WorkerHandle = { id: this.#id('worker') };
    this.#workers.set(handle.id, {
      handle,
      knows: options.knows === undefined ? undefined : new Set(options.knows),
      concurrency: options.concurrency ?? 1,
      attempts: new Set(),
      fetching: true,
    });
    this.#pump();
    return Promise.resolve(handle);
  }

  #pump(): void {
    const now = this.#now();
    for (const worker of this.#workers.values()) {
      while (worker.fetching && worker.attempts.size < worker.concurrency) {
        const job = [...this.#jobs.values()].find(
          (candidate) => candidate.state === 'waiting' && candidate.runAt <= now,
        );
        if (job === undefined) break;
        this.#deliver(worker, job);
      }
    }
    this.#armWake(now);
  }

  /**
   * Keep one wake-up armed for the earliest job that is waiting but not yet
   * due. Timers run on the event loop's monotonic clock while `runAt` is
   * measured with `Date.now()`, so a timer can fire while the job is still a
   * millisecond short of due; the pump it triggers then re-arms for the
   * remainder instead of leaving the job waiting with no timer at all. `now`
   * is the instant the caller judged due jobs by: reading the clock again
   * could step past a job the caller found not yet due, leaving it neither
   * delivered nor woken for.
   */
  #armWake(now: number): void {
    let earliest = Infinity;
    for (const job of this.#jobs.values()) {
      if (job.state === 'waiting' && job.runAt > now) earliest = Math.min(earliest, job.runAt);
    }
    if (earliest === Infinity) return;
    if (this.#wakeAt !== undefined && this.#wakeAt <= earliest) return;
    this.#wakeAt = earliest;
    // setTimeout fires at once past this bound; a too-early wake re-arms.
    this.#later(Math.min(earliest - now, MAX_TIMER_MS), () => {
      if (this.#wakeAt === earliest) this.#wakeAt = undefined;
      this.#pump();
    });
  }

  /** Run one attempt of `job` on `worker`. */
  #deliver(worker: Worker, job: StoredJob): void {
    const definition = this.#definitions.get(job.call.name);
    if (
      definition === undefined ||
      (worker.knows !== undefined && !worker.knows.has(job.call.name))
    ) {
      job.unknownCount += 1;
      this.#events.push({ kind: 'released', name: job.call.name, jobId: job.id });
      if (job.unknownCount > MAX_UNKNOWN_RELEASES) {
        this.#fail(job);
        return;
      }
      // #pump arms the wake-up that delivers it again.
      job.runAt = this.#now() + UNKNOWN_RELEASE_MS;
      return;
    }
    const overlap = definition.overlap;
    if (overlap !== undefined) {
      const holder = this.#leases.get(overlap.key);
      if (holder !== undefined && holder !== job.id) {
        job.state = 'completed';
        this.#events.push({ kind: 'skipped', name: job.call.name, jobId: job.id });
        return;
      }
      this.#leases.set(overlap.key, job.id);
    }
    job.state = 'active';
    const controller = new AbortController();
    const run = async (): Promise<void> => {
      const next = (): Promise<void> =>
        definition.handle(structuredClone(job.call.payload), {
          jobId: job.id,
          attempt: job.attemptsMade + 1,
          signal: controller.signal,
          dispatch: (call, options) => this.dispatch(call, options),
        });
      if (definition.middleware === undefined) {
        await next();
      } else {
        await definition.middleware({ name: job.call.name, signal: controller.signal }, next);
      }
    };
    const attempt: Attempt = {
      job,
      controller,
      aborted: false,
      settled: run().then(
        () => this.#settle(worker, attempt, true),
        () => this.#settle(worker, attempt, false),
      ),
    };
    worker.attempts.add(attempt);
  }

  #settle(worker: Worker, attempt: Attempt, succeeded: boolean): void {
    worker.attempts.delete(attempt);
    const { job } = attempt;
    const overlap = this.#definitions.get(job.call.name)?.overlap;
    if (overlap !== undefined && this.#leases.get(overlap.key) === job.id) {
      this.#leases.delete(overlap.key);
    }
    if (succeeded) {
      job.state = 'completed';
      this.#events.push({ kind: 'completed', name: job.call.name, jobId: job.id });
      this.#advance(job, 'completed');
    } else if (attempt.aborted) {
      job.state = 'waiting';
      this.#events.push({ kind: 'released', name: job.call.name, jobId: job.id });
    } else {
      job.attemptsMade += 1;
      const attempts = this.#definitions.get(job.call.name)?.attempts ?? 1;
      if (job.attemptsMade < attempts) {
        job.state = 'waiting';
      } else {
        this.#events.push({ kind: 'failed', name: job.call.name, jobId: job.id });
        this.#fail(job);
      }
    }
    this.#pump();
  }

  #fail(job: StoredJob): void {
    job.state = 'failed';
    this.#failed.add(job.id);
    this.#advance(job, 'failed');
  }

  /** Flow bookkeeping after a final outcome. Every follow-up is a keyed enqueue. */
  #advance(job: StoredJob, outcome: 'completed' | 'failed'): void {
    const flow = job.flow;
    if (flow === undefined) return;
    if (flow.kind === 'chain') {
      const chain = this.#chains.get(flow.id);
      const next = chain?.steps[flow.step + 1];
      if (outcome === 'completed' && next !== undefined) {
        this.#enqueue(
          next,
          { key: `chain:${flow.id}:${flow.step + 1}` },
          { kind: 'chain', id: flow.id, step: flow.step + 1 },
        );
      }
      if (outcome === 'failed' && chain?.catch !== undefined && !job.catchFired) {
        job.catchFired = true;
        this.#enqueue(chain.catch, { key: `chain:${flow.id}:catch` }, undefined);
      }
      return;
    }
    const batch = this.#batches.get(flow.id);
    if (batch === undefined || batch.recorded.has(flow.index)) return;
    batch.recorded.set(flow.index, outcome);
    if (batch.settled || batch.recorded.size < batch.total) return;
    batch.settled = true;
    const anyFailed = [...batch.recorded.values()].includes('failed');
    const decided = anyFailed ? batch.callbacks.catch : batch.callbacks.then;
    if (decided !== undefined) {
      this.#enqueue(
        decided,
        { key: `batch:${flow.id}:${anyFailed ? 'catch' : 'then'}` },
        undefined,
      );
    }
    if (batch.callbacks.finally !== undefined) {
      this.#enqueue(batch.callbacks.finally, { key: `batch:${flow.id}:finally` }, undefined);
    }
  }

  async #stop(handle: WorkerHandle, deadlineMs: number): Promise<void> {
    const worker = this.#workers.get(handle.id);
    if (worker === undefined) return;
    worker.fetching = false;
    const all = (): Promise<void> =>
      Promise.all([...worker.attempts].map((attempt) => attempt.settled)).then(() => undefined);
    const bounded = (ms: number): Promise<void> =>
      Promise.race([all(), new Promise<void>((resolve) => setTimeout(resolve, ms))]);
    await bounded(deadlineMs);
    for (const attempt of worker.attempts) {
      attempt.aborted = true;
      attempt.controller.abort(new Error('worker shutting down'));
    }
    // Handlers that ignore the signal keep their job held until they settle.
    await bounded(ABORT_GRACE_MS);
    this.#workers.delete(handle.id);
  }

  drain(worker: WorkerHandle): Promise<void> {
    return this.#stop(worker, this.#options.drainDeadlineMs);
  }

  abort(worker: WorkerHandle): Promise<void> {
    return this.#stop(worker, 0);
  }

  async redeliver(jobId: string): Promise<void> {
    const job = this.#jobs.get(jobId);
    const worker = [...this.#workers.values()].find((candidate) => candidate.fetching);
    if (job === undefined || worker === undefined) throw new Error('nothing to redeliver');
    this.#deliver(worker, job);
    this.#armWake(this.#now());
    await Promise.all([...worker.attempts].map((attempt) => attempt.settled));
  }

  evictCompleted(): Promise<void> {
    for (const [id, job] of this.#jobs) {
      if (job.state === 'completed') this.#jobs.delete(id);
    }
    return Promise.resolve();
  }

  restartProducer(): Promise<void> {
    // The producer holds nothing the store does not.
    return Promise.resolve();
  }

  failed(): Promise<readonly FailedJob[]> {
    return Promise.resolve(
      [...this.#failed].map((id) => {
        const job = this.#jobs.get(id)!;
        return {
          id,
          queue: 'default',
          envelope: {
            v: JOB_ENVELOPE_VERSION,
            name: job.call.name,
            payload: job.call.payload,
            options: {},
            meta: {
              ...(job.tags === undefined ? {} : { tags: job.tags }),
              dispatchedAt: job.dispatchedAt,
            },
          },
          error: { name: 'Error', kind: 'internal' },
          failedAt: job.dispatchedAt,
        } satisfies FailedJob;
      }),
    );
  }

  retry(id: string, options: { readonly force?: boolean } = {}): Promise<RetryResult> {
    const job = this.#jobs.get(id);
    if (job === undefined) return Promise.resolve('not_found');
    if (!this.#failed.has(id)) return Promise.resolve('not_failed');
    if (job.catchFired && options.force !== true) return Promise.resolve('not_retryable');
    this.#failed.delete(id);
    if (job.flow?.kind === 'batch') {
      const batch = this.#batches.get(job.flow.id);
      if (batch?.settled === true) batch.retriedAfterSettlement += 1;
      else batch?.recorded.delete(job.flow.index);
    }
    job.state = 'waiting';
    job.attemptsMade = 0;
    job.unknownCount = 0;
    job.runAt = this.#now();
    this.#pump();
    return Promise.resolve('retried');
  }

  reconcileSchedules(schedules: readonly ScenarioSchedule[]): Promise<void> {
    const declared = new Set(schedules.map((schedule) => schedule.id));
    for (const id of [...this.#schedules.keys()]) {
      if (!declared.has(id)) this.#schedules.delete(id);
    }
    for (const spec of schedules) {
      const existing = this.#schedules.get(spec.id);
      this.#schedules.set(spec.id, {
        spec,
        nextAt: existing?.nextAt ?? nextFire(spec, this.#now()),
        paused: existing?.paused ?? false,
      });
    }
    return Promise.resolve();
  }

  pauseSchedule(id: string): Promise<void> {
    const schedule = this.#schedules.get(id);
    if (schedule !== undefined) schedule.paused = true;
    return Promise.resolve();
  }

  resumeSchedule(id: string): Promise<void> {
    const schedule = this.#schedules.get(id);
    if (schedule !== undefined && schedule.paused) {
      schedule.paused = false;
      // The fire times missed while paused are skipped.
      while (schedule.nextAt <= this.#now()) {
        schedule.nextAt = nextFire(schedule.spec, schedule.nextAt);
      }
    }
    return Promise.resolve();
  }

  async advance(ms: number): Promise<void> {
    const target = this.#virtualNow + ms;
    for (;;) {
      const timer = this.#timers.toSorted((a, b) => a.at - b.at)[0];
      const schedule = [...this.#schedules.values()].toSorted((a, b) => a.nextAt - b.nextAt)[0];
      const at = Math.min(timer?.at ?? Infinity, schedule?.nextAt ?? Infinity);
      if (at > target) break;
      this.#virtualNow = at;
      if (timer !== undefined && timer.at === at) {
        this.#timers.splice(this.#timers.indexOf(timer), 1);
        timer.fire();
      } else if (schedule !== undefined) {
        schedule.nextAt = nextFire(schedule.spec, schedule.nextAt);
        if (!schedule.paused) this.#enqueue(schedule.spec.call, {}, undefined);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.#virtualNow = target;
    this.#pump();
    await this.settle();
  }

  async settle(): Promise<void> {
    const deadline = performance.now() + SETTLE_BOUND_MS;
    let quiet = 0;
    while (quiet < 3) {
      await new Promise((resolve) => setImmediate(resolve));
      const now = this.#now();
      const busy = [...this.#workers.values()].some((worker) => worker.attempts.size > 0);
      const runnable =
        [...this.#workers.values()].some((worker) => worker.fetching) &&
        [...this.#jobs.values()].some((job) => job.state === 'waiting' && job.runAt <= now);
      quiet = busy || runnable ? 0 : quiet + 1;
      if (performance.now() > deadline) throw new Error('the reference store did not settle');
    }
  }

  events(): readonly JobEvent[] {
    return [...this.#events];
  }

  async close(): Promise<void> {
    for (const worker of [...this.#workers.values()]) await this.abort(worker.handle);
    for (const timer of this.#realTimers) clearTimeout(timer);
    this.#realTimers.clear();
    this.#timers.length = 0;
    this.#wakeAt = undefined;
  }
}

export function createReferenceDriver(options: DriverOptions): JobsHarnessDriver {
  return new ReferenceDriver(options);
}
