/**
 * `startRuntimeWorker`: the worker runtime over any {@link JobsAdapter}. It
 * hands the adapter the package's processor and owns the worker's lifecycle,
 * `open → draining → closed`.
 *
 * Two duties are split between the adapter and the runtime. The adapter keeps
 * a job held (slot and lock) until its processor settles, however long that
 * takes; the runtime bounds how long its caller waits and decides when the
 * process must die:
 *
 * - `drain()` stops fetching and waits for in-flight attempts; with a
 *   deadline, it aborts whatever still runs then. An `abort()` meanwhile,
 *   a poisoning's included, ends the drain as soon as that abort returns.
 * - `abort()` stops fetching, aborts every in-flight attempt, and waits at
 *   most `abortCollectMs` for them to report. Every attempt that reports in
 *   time reaches the transport as its outcome (a cooperative handler's is
 *   `released: shutdown`, attempts unchanged); an attempt whose code still
 *   runs stays held (`held` says how many), and the host exits instead of
 *   closing the adapter.
 * - An aborted or timed-out attempt whose code keeps running past
 *   `handlerGraceMs` poisons the worker: it aborts (stops fetching, the other
 *   attempts come back released) and then calls `onPoisoned`, by default
 *   {@link exitPoisonedProcess}, which ends the process with code 75 for its
 *   supervisor to restart. The stuck attempt is never resolved early: its job
 *   is redelivered only once the process holding it is gone, so it never runs
 *   twice at once.
 *
 * The processor advances chains, fires their catches and finalizes batches
 * as the follow-ups of its outcomes, which the adapter stores when it
 * settles each job; schedules are fired by the transport. A catalog with
 * an overlap-controlled job needs an adapter with leases, checked here
 * before any job runs.
 *
 * The producer handlers dispatch through is a separate unit: an in-flight
 * attempt keeps dispatching while its worker drains, and the host closes the
 * producer after the worker. The runtime's timers run on its own clock, apart
 * from the adapter's, so a transport on virtual time still has real bounds.
 */

import type { SignalBus } from 'jsails/signals';

import type { AdapterWorker, JobsAdapter, SettleEvent } from '../contract/index.js';
import type { JobCatalog } from '../definition/catalog.js';
import { jobSpec } from '../definition/define-job.js';
import type { Jobs } from '../definition/jobs-service.js';
import { MAX_JOB_DELAY_MS, validDuration } from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { MAX_QUEUE_CONCURRENCY } from '../queues/queue-set.js';
import { setLongTimeout, systemClock, type JobsClock } from '../timing/long-timer.js';
import type { AttemptLedger } from './attempt.js';
import { emitSettleSignal, escalate } from './job-signals.js';
import { exitPoisonedProcess } from './poisoned-exit.js';
import { createProcessor } from './processor.js';

/**
 * How long an aborted or timed-out attempt may keep running before the
 * worker is poisoned, unless the worker states its own.
 *
 * @public
 */
export const DEFAULT_HANDLER_GRACE_MS = 30_000;

/**
 * How long `abort()` waits for aborted attempts to report, unless the worker
 * states its own.
 *
 * @public
 */
export const DEFAULT_ABORT_COLLECT_MS = 1_000;

/** The longest `abortCollectMs`. */
export const MAX_ABORT_COLLECT_MS = 60_000;

/**
 * What {@link startRuntimeWorker} takes.
 *
 * @public
 */
export interface RuntimeWorkerOptions<Q extends string = string> {
  readonly catalog: JobCatalog<Q>;
  readonly adapter: JobsAdapter;
  /** The dispatcher handlers receive: a separate unit, closed by the host after the worker. */
  readonly jobs: Jobs;
  /** The queues to work. Defaults to every catalog queue. */
  readonly queues?: readonly Q[];
  /** Attempts in flight per queue. Defaults to each queue's declared concurrency. */
  readonly concurrency?: number;
  /**
   * How long an aborted or timed-out attempt may keep running before the
   * worker is poisoned: 1 ms to one year. Defaults to 30 s.
   */
  readonly handlerGraceMs?: number;
  /** How long `abort()` waits for aborted attempts to report: 0 to 60 000 ms. Defaults to 1 s. */
  readonly abortCollectMs?: number;
  /**
   * Keep each error's own message in failure summaries. Off by default: a
   * message is where payload data ends up.
   */
  readonly storeErrorMessages?: boolean;
  /** Where `jobCompleted`, `jobSkipped`, `jobReleased` and `jobFailed` are emitted. */
  readonly signals?: SignalBus;
  /** The runtime's timers; defaults to the system clock. Separate from the adapter's clock. */
  readonly clock?: JobsClock;
  /** Called once when the worker is poisoned. Defaults to {@link exitPoisonedProcess}. */
  readonly onPoisoned?: (report: PoisonedWorkerReport) => void;
}

/**
 * A runtime worker's lifecycle state.
 *
 * @public
 */
export type RuntimeWorkerState = 'open' | 'draining' | 'closed';

/**
 * What `onPoisoned` learns.
 *
 * @public
 */
export interface PoisonedWorkerReport {
  /** Attempts whose code has not settled, still held by the adapter. */
  readonly held: number;
}

/**
 * Options of {@link RuntimeWorker.drain}.
 *
 * @public
 */
export interface DrainOptions {
  /** Abort whatever still runs after this many milliseconds. */
  readonly deadlineMs?: number;
}

/**
 * A running worker.
 *
 * @public
 */
export interface RuntimeWorker {
  readonly state: RuntimeWorkerState;
  /** True once an attempt outlived its grace. */
  readonly poisoned: boolean;
  /** Attempts whose code has not settled (held by the adapter). */
  readonly held: number;
  /**
   * Stop fetching and wait for in-flight attempts; with `deadlineMs`, abort
   * whatever still runs then. An `abort()` meanwhile ends the drain too.
   */
  drain(options?: DrainOptions): Promise<void>;
  /**
   * Stop fetching, abort in-flight attempts, and wait at most
   * `abortCollectMs` for them to report. Idempotent.
   */
  abort(): Promise<void>;
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'catalog',
  'adapter',
  'jobs',
  'queues',
  'concurrency',
  'handlerGraceMs',
  'abortCollectMs',
  'storeErrorMessages',
  'signals',
  'clock',
  'onPoisoned',
]);

function invalid(option: string): Error {
  return new JobsErrors.Error('invalid_worker', { option });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasMethods(value: unknown, methods: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && methods.every((method) => typeof value[method] === 'function');
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

interface CheckedOptions {
  readonly catalog: JobCatalog;
  readonly adapter: JobsAdapter;
  readonly jobs: Jobs;
  readonly queues: readonly string[];
  readonly concurrency: number | undefined;
  readonly handlerGraceMs: number;
  readonly abortCollectMs: number;
  readonly storeErrorMessages: boolean;
  readonly signals: SignalBus | undefined;
  readonly clock: JobsClock;
  readonly onPoisoned: (report: PoisonedWorkerReport) => void;
}

function checkedOptions(value: unknown): CheckedOptions {
  if (!isRecord(value)) throw invalid('options');
  if (!Object.keys(value).every((key) => OPTION_KEYS.has(key))) {
    throw new JobsErrors.Error('unknown_option');
  }
  const { catalog, adapter, jobs, queues, concurrency, handlerGraceMs, abortCollectMs } = value;
  if (
    !hasMethods(catalog, ['get']) ||
    !isRecord(catalog.queues) ||
    !Array.isArray(catalog.definitions)
  ) {
    throw invalid('catalog');
  }
  const queueSet = (catalog as unknown as JobCatalog).queues;
  if (!hasMethods(adapter, ['startWorker', 'enqueue']) || !isRecord(adapter.capabilities)) {
    throw invalid('adapter');
  }
  if (
    !hasMethods(jobs, [
      'dispatch',
      'dispatchByName',
      'chain',
      'batch',
      'batchStatus',
      'batchFailures',
    ])
  ) {
    throw invalid('jobs');
  }
  let names: readonly string[] = queueSet.names;
  if (queues !== undefined) {
    if (
      !Array.isArray(queues) ||
      queues.length === 0 ||
      !(queues as unknown[]).every((queue) => typeof queue === 'string' && queueSet.has(queue))
    ) {
      throw invalid('queues');
    }
    names = Object.freeze([...new Set(queues as string[])]);
  }
  if (concurrency !== undefined && !integerIn(concurrency, 1, MAX_QUEUE_CONCURRENCY)) {
    throw invalid('concurrency');
  }
  if (handlerGraceMs !== undefined && validDuration(handlerGraceMs) === undefined) {
    throw invalid('handlerGraceMs');
  }
  if (abortCollectMs !== undefined && !integerIn(abortCollectMs, 0, MAX_ABORT_COLLECT_MS)) {
    throw invalid('abortCollectMs');
  }
  if (value.storeErrorMessages !== undefined && typeof value.storeErrorMessages !== 'boolean') {
    throw invalid('storeErrorMessages');
  }
  if (value.signals !== undefined && !hasMethods(value.signals, ['emit'])) {
    throw invalid('signals');
  }
  if (value.clock !== undefined && !hasMethods(value.clock, ['now', 'setTimer'])) {
    throw invalid('clock');
  }
  if (value.onPoisoned !== undefined && typeof value.onPoisoned !== 'function') {
    throw invalid('onPoisoned');
  }
  const checkedCatalog = catalog as unknown as JobCatalog;
  const checkedAdapter = adapter as unknown as JobsAdapter;
  if (
    checkedAdapter.capabilities.leases === undefined &&
    checkedCatalog.definitions.some((definition) => jobSpec(definition).overlap !== undefined)
  ) {
    throw new JobsErrors.Error('capability_missing', { capability: 'leases' });
  }
  return {
    catalog: checkedCatalog,
    adapter: checkedAdapter,
    jobs: jobs as unknown as Jobs,
    queues: names,
    concurrency,
    handlerGraceMs: (handlerGraceMs as number | undefined) ?? DEFAULT_HANDLER_GRACE_MS,
    abortCollectMs: abortCollectMs ?? DEFAULT_ABORT_COLLECT_MS,
    storeErrorMessages: value.storeErrorMessages === true,
    signals: value.signals as SignalBus | undefined,
    clock: (value.clock as JobsClock | undefined) ?? systemClock,
    onPoisoned:
      (value.onPoisoned as ((report: PoisonedWorkerReport) => void) | undefined) ??
      exitPoisonedProcess,
  };
}

type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

function outcomeOf(work: Promise<void>): Promise<Outcome> {
  return work.then(
    (): Outcome => ({ ok: true }),
    (error: unknown): Outcome => ({ ok: false, error }),
  );
}

/**
 * Resolve with `work`'s outcome, or `undefined` once `ms` passed on `clock`
 * (never, without `ms`) or `cut` resolved, whichever comes first. The timer
 * is cancelled either way, so nothing stays pending for the rest of `ms`.
 */
function within(
  work: Promise<Outcome>,
  ms: number | undefined,
  clock: JobsClock,
  cut?: Promise<void>,
): Promise<Outcome | undefined> {
  return new Promise((resolve) => {
    const timer =
      ms === undefined ? undefined : setLongTimeout(() => resolve(undefined), ms, clock);
    const end = (outcome: Outcome | undefined): void => {
      timer?.cancel();
      resolve(outcome);
    };
    work.then(end, escalate);
    cut?.then(() => end(undefined), escalate);
  });
}

class Runtime implements RuntimeWorker, AttemptLedger {
  readonly #options: CheckedOptions;
  #worker: AdapterWorker | undefined;
  #state: RuntimeWorkerState = 'open';
  #poisoned = false;
  #held = 0;
  #draining: Promise<void> | undefined;
  #aborting: Promise<void> | undefined;
  #abortRequested: () => void = () => undefined;
  readonly #abortRequest: Promise<void>;

  constructor(options: CheckedOptions) {
    this.#options = options;
    this.#abortRequest = new Promise((resolve) => {
      this.#abortRequested = resolve;
    });
  }

  get state(): RuntimeWorkerState {
    return this.#state;
  }

  get poisoned(): boolean {
    return this.#poisoned;
  }

  get held(): number {
    return this.#held;
  }

  /** Start the adapter worker. A poisoning before it returned is applied at once. */
  async start(): Promise<void> {
    const { adapter, queues, concurrency, signals } = this.#options;
    const processor = createProcessor({
      catalog: this.#options.catalog,
      jobs: this.#options.jobs,
      transport: adapter,
      clock: this.#options.clock,
      handlerGraceMs: this.#options.handlerGraceMs,
      storeErrorMessages: this.#options.storeErrorMessages,
      ledger: this,
    });
    this.#worker = await adapter.startWorker(
      {
        queues,
        ...(concurrency === undefined ? {} : { concurrency }),
        ...(signals === undefined
          ? {}
          : { onSettle: (event: SettleEvent) => emitSettleSignal(signals, event) }),
      },
      processor,
    );
    if (this.#poisoned) this.#reportPoisoned(this.abort());
  }

  enter(): void {
    this.#held += 1;
  }

  leave(): void {
    this.#held -= 1;
  }

  poison(): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    // Started workers abort now; one still starting does when it returns.
    if (this.#worker !== undefined) this.#reportPoisoned(this.abort());
  }

  /** Call `onPoisoned` once the abort's collect bound passed, so released jobs reached the transport. */
  #reportPoisoned(aborting: Promise<void>): void {
    const report = (): void => this.#options.onPoisoned(Object.freeze({ held: this.#held }));
    aborting.then(report, (error: unknown) => {
      report();
      escalate(error);
    });
  }

  drain(options: DrainOptions = {}): Promise<void> {
    if (!isRecord(options)) return Promise.reject(invalid('drain'));
    const { deadlineMs } = options;
    if (deadlineMs !== undefined && !integerIn(deadlineMs, 0, MAX_JOB_DELAY_MS)) {
      return Promise.reject(invalid('deadlineMs'));
    }
    if (this.#aborting !== undefined) return this.#aborting;
    this.#draining ??= this.#drain(deadlineMs);
    return this.#draining;
  }

  async #drain(deadlineMs: number | undefined): Promise<void> {
    const worker = this.#started();
    this.#state = 'draining';
    const drained = outcomeOf(worker.drain());
    // An abort meanwhile (the host's, or a poisoning's) ends the drain at
    // once, deadline or not: the drain then resolves as that abort does.
    const settled = await within(drained, deadlineMs, this.#options.clock, this.#abortRequest);
    if (settled === undefined) {
      this.#escalateLate(drained);
      return this.abort();
    }
    this.#finish(settled);
  }

  abort(): Promise<void> {
    if (this.#aborting !== undefined) return this.#aborting;
    if (this.#state === 'closed' && this.#draining !== undefined) return this.#draining;
    this.#abortRequested();
    this.#aborting = this.#abort();
    return this.#aborting;
  }

  async #abort(): Promise<void> {
    const worker = this.#started();
    this.#state = 'draining';
    // The adapter aborts every in-flight signal before this call returns.
    const stopping = outcomeOf(worker.abort());
    const settled = await within(stopping, this.#options.abortCollectMs, this.#options.clock);
    if (settled === undefined) {
      // Attempts still held stay held until their code settles or the grace
      // poisons the worker; a rejection after the bound is not dropped.
      this.#escalateLate(stopping);
      this.#state = 'closed';
      return;
    }
    this.#finish(settled);
  }

  #started(): AdapterWorker {
    if (this.#worker === undefined) throw invalid('state');
    return this.#worker;
  }

  #finish(outcome: Outcome): void {
    this.#state = 'closed';
    if (!outcome.ok) throw outcome.error;
  }

  #escalateLate(work: Promise<Outcome>): void {
    work.then((outcome) => {
      if (!outcome.ok) escalate(outcome.error);
    }, escalate);
  }
}

/**
 * Start a worker runtime: the processor over `adapter`, working `queues`.
 *
 * @throws (as a rejection) `jobs.invalid_worker` naming the option at fault,
 *   `jobs.unknown_option` for a field that is not an option,
 *   `jobs.capability_missing` when a job has overlap control and the adapter
 *   has no leases, and whatever the adapter's `startWorker` refuses.
 * @public
 */
export async function startRuntimeWorker<Q extends string>(
  options: RuntimeWorkerOptions<Q>,
): Promise<RuntimeWorker> {
  const runtime = new Runtime(checkedOptions(options));
  await runtime.start();
  return runtime;
}
