/**
 * Provider-neutral job runtime controller.
 *
 * {@link JobsRuntimeImpl} binds a {@link JobRegistry} to a {@link JobsRuntimeAdapter}
 * — a small, transport-specific implementation (a BullMQ bridge, an in-memory
 * test adapter, or any other queue). The controller owns the job-level policy
 * that must hold for every provider:
 *
 * - payloads are validated against the registry schema on dispatch AND on
 *   processing, so a bad payload never reaches a handler unvalidated;
 * - dispatch options go through the same allowlist as the built-in queue;
 * - schedules are validated locally (ids, known jobs, interval/cron
 *   exclusivity, timezone, payload) before any provider call;
 * - producer and worker handles are created lazily on first use and closed
 *   idempotently;
 * - every attempt runs in its own execution context (`jsails/context`),
 *   restored from the carrier its dispatch stored: the dispatcher's request
 *   id, a child span of its trace, and its propagated values (locale,
 *   tenant). Nothing of whichever call happened to start the attempt (a
 *   request whose dispatch pumped an in-memory queue, the previous job, a
 *   timer) reaches it, and a job dispatched outside any context runs in a
 *   new one with no tenant;
 * - every attempt can be bounded by a timeout that aborts `context.signal`,
 *   and `close()` waits for in-flight jobs only up to a drain deadline;
 * - a job that can never succeed (unknown name, invalid payload, `retryOn`
 *   returning `false`, an {@link UnrecoverableJobError}) is marked
 *   non-retryable so the adapter fails it terminally instead of retrying;
 * - every failed attempt is reported (a `jobFailed` signal carrying an error
 *   summary, and a log line by default), and a job that fails for the last
 *   time is recorded in the optional {@link FailedJobHistory};
 * - `upsertSchedules` prunes provider schedules that are no longer declared.
 *
 * The adapter — not this module — owns the connection, protocol, retry, and
 * execution semantics. This module exposes no BullMQ/ioredis types in its
 * public signatures, so a custom adapter can target any backend without
 * depending on the built-in stack. A custom adapter needs no connection URL at
 * all: `JobsRuntimeImpl` never receives one.
 *
 * Scheduling is **at-least-once**: no exactly-once, non-overlap, or catch-up
 * guarantee is provided; handlers must be idempotent.
 */

import { DEFAULT_PREFIX, DEFAULT_QUEUE_NAME } from './connection.js';
import {
  jobCompleted,
  jobFailed,
  jobPushed,
  jobRetried,
  summarizeJobError,
  type JobErrorSummary,
  type JobEventPayload,
} from './events.js';
import {
  composeMiddleware,
  JobMiddlewareError,
  type JobMiddleware,
  type JobMiddlewareContext,
} from './middleware.js';
import { isLeaseStore, type LeaseStore } from '../cache/lease.js';
import { type SignalBus } from '../signals/signal-bus.js';
import { type PausedScheduleStore } from './paused-schedules.js';
import {
  isFailedJobHistory,
  jobMembership,
  replayableJobOptions,
  type FailedJobHistory,
} from './failed-job-history.js';
import { normalizeTags } from './tags.js';
import { validateJobOptions } from './queue.js';
import {
  JobNotRegisteredError,
  jobPolicy,
  jobTimeout,
  MAX_JOB_TIMEOUT_MS,
  validatePayload,
  type JobContext,
  type JobRegistry,
} from './registry.js';
import {
  isOverlapDescriptor,
  prepareSchedules,
  type OverlapDescriptor,
  type PreparedSchedule,
  type ScheduleDefinition,
} from './scheduler.js';
import { CONTEXT_OPTION_KEY, OVERLAP_OPTION_KEY, TAG_OPTION_KEY } from './option-keys.js';
import { createOverlapMiddleware, isOverlapMiddleware } from './overlap.js';
import { type Awaitable } from '../contracts/awaitable.js';
import type { ServiceRegistry } from '../extensions/services.js';
import type { TransportReach } from '../plugins/contract/lifecycle.js';
import { appScopeEntry } from '../facades/app-scope.js';
import {
  createExecutionContext,
  extendContext,
  runInContext,
  type ContextEntry,
  type ExecutionContext,
} from '../context/execution-context.js';
import { restoreContext, serializeContext } from '../context/carrier.js';
import { JsailsError } from '../errors/jsails-error.js';

/** Validated options handed to a provider's `dispatch`. */
export type JobDispatchOptions = Record<string, unknown>;

/**
 * The execution context a received job runs in: the one its dispatch carried
 * (a child span of the dispatcher's, its request id and propagated values),
 * or a new one when it carried none, with `scope` (the application scope) set
 * either way. A carrier that does not restore can never restore on a retry
 * either, so the failure is terminal.
 */
function jobExecutionContext(
  opts: unknown,
  scope: readonly ContextEntry<unknown>[],
): ExecutionContext {
  const carrier =
    opts !== null && typeof opts === 'object'
      ? (opts as Record<string, unknown>)[CONTEXT_OPTION_KEY]
      : undefined;
  if (carrier === undefined) return createExecutionContext({ values: scope });
  try {
    return extendContext(restoreContext(carrier), scope);
  } catch (error) {
    throw markJobErrorNonRetryable(error);
  }
}

/** Neutral context describing the queue a runtime adapter binds to. */
export interface JobAdapterContext {
  readonly queueName: string;
  readonly prefix: string;
  readonly concurrency: number;
  readonly registry: JobRegistry;
}

/** Read-only queue metrics, normalized across transport backends. */
export interface QueueCounts {
  /** Jobs waiting to be processed. */
  readonly waiting: number;
  /** Jobs currently being processed. */
  readonly active: number;
  /** Jobs finished successfully. */
  readonly completed: number;
  /** Jobs finished with an error after exhausting retries. */
  readonly failed: number;
  /** Jobs scheduled to run later. */
  readonly delayed: number;
}

/** The producer surface a runtime adapter must provide. */
export interface RuntimeProducer {
  /** Enqueue a payload already validated by the controller. */
  dispatch(name: string, data: unknown, options: JobDispatchOptions): Promise<unknown>;
  /** Close the producer and its owned resources. Idempotent. */
  close(): Promise<void>;
  /**
   * Read queue metrics when the underlying transport supports them. Absent on
   * backends without a countable queue (a capability, not a requirement).
   */
  readCounts?(): Promise<QueueCounts>;
  /**
   * Pause the queue so no new jobs are processed. Non-durable and
   * process-scoped: the provider owns the pause state, and a restarted
   * process sees the provider's own default. Absent on backends without a
   * pausable queue (a capability, not a requirement).
   */
  pause?(): Promise<void>;
  /**
   * Resume a paused queue so jobs are processed again. Non-durable and
   * process-scoped: the provider owns the resume state. Absent on backends
   * without a pausable queue (a capability, not a requirement).
   */
  resume?(): Promise<void>;
}

/** A received job as seen by the neutral processor. */
export interface RuntimeJob {
  readonly name: string;
  readonly id?: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly attemptsStarted: number;
  /**
   * Raw dispatch options as set at enqueue time. BullMQ surfaces these as
   * `job.opts`; a custom adapter may omit them. Framework features such as
   * job chaining read reserved keys from this field.
   */
  readonly opts?: unknown;
  log(message: string): Promise<unknown>;
  updateProgress(progress: number | Record<string, unknown>): Promise<void>;
}

/** Process one received job: validate it, then invoke the registry handler. */
export type ProcessJob = (job: RuntimeJob) => Promise<unknown>;

/** The worker surface a runtime adapter must provide. */
export interface RuntimeWorker {
  /** Shut the worker down; `force` skips draining in-flight jobs. Idempotent. */
  close(force?: boolean): Promise<void>;
}

/**
 * A read-only view of one registered schedule, normalized across backends.
 */
export interface ScheduleInfo {
  /** The schedule id. */
  readonly id: string;
  /** The job name the schedule dispatches. */
  readonly job: string;
  /** A human-readable repeat description (e.g. `every 5000ms` or a cron pattern). */
  readonly repeat: string;
  /** Epoch milliseconds of the next run, when the backend can report it. */
  readonly nextRunAt?: number;
  /** The resolved overlap descriptor, when the schedule opts into overlap control. */
  readonly overlap?: OverlapDescriptor;
  /** Human-readable label stored with the schedule, when one was declared. */
  readonly description?: string;
}

/**
 * The pluggable adapter contract. `createProducer`/`createWorker` are lazy:
 * the controller calls them only on first use. An adapter that throws from
 * either call owns the cleanup of whatever it partially created.
 */
export interface JobsRuntimeAdapter {
  /** Diagnostic label, never used for identity or routing. */
  readonly name: string;
  /**
   * How far a dispatched job travels: `process` (the in-memory adapter) only
   * to a worker of the same adapter instance in the same process, `shared`
   * to any worker on the transport. The kernel refuses a process that runs
   * only one side of a `process` adapter. Absent: not checked.
   */
  readonly reach?: TransportReach;
  createProducer(context: JobAdapterContext): Awaitable<RuntimeProducer>;
  /**
   * When `processJob` rejects with an error that
   * {@link isJobAttemptInterrupted} accepts, the adapter must return the job
   * to its queue without counting the attempt; the runtime has not reported
   * or recorded it, so counting it could fail the job with no trace.
   */
  createWorker(context: JobAdapterContext, processJob: ProcessJob): Awaitable<RuntimeWorker>;
  /**
   * Optional scheduler capability. Receives the producer handle this runtime
   * created (so a stateful adapter can recover its native queue) plus fully
   * validated, provider-neutral schedules. When absent, `upsertSchedules`
   * throws instead of silently doing nothing.
   */
  upsertSchedules?(
    producer: RuntimeProducer,
    schedules: readonly PreparedSchedule[],
  ): Promise<void>;
  /**
   * Optional schedule-inspection capability. Returns a value-free view of the
   * schedules registered on the producer this runtime created. When absent,
   * `listSchedules` throws instead of silently returning an empty list.
   */
  listSchedules?(producer: RuntimeProducer): Promise<readonly ScheduleInfo[]>;
  /**
   * Optional schedule-pause capability. Removes the named schedules so they stop
   * firing. Non-durable: a later `work` start re-registers them. When absent,
   * `pauseSchedules` throws.
   */
  pauseSchedules?(producer: RuntimeProducer, ids: readonly string[]): Promise<void>;
  /**
   * Optional schedule-removal capability. Deletes the named schedules from the
   * provider. With `listSchedules`, it lets `upsertSchedules` prune schedules
   * that are no longer declared; without it, stale schedules are left alone.
   */
  removeSchedules?(producer: RuntimeProducer, ids: readonly string[]): Promise<void>;
}

/** Options for {@link JobsRuntime.upsertSchedules}. */
export interface UpsertSchedulesOptions {
  /**
   * Remove provider schedules whose ids are not in the declared list (a
   * renamed or deleted schedule stops firing). Defaults to `true`; pass
   * `false` when registering a subset of a queue's schedules.
   */
  readonly prune?: boolean;
}

/** A failed attempt, as reported to `onJobFailed`. Never carries job data. */
export interface JobFailureInfo {
  readonly name: string;
  readonly jobId: string | undefined;
  /** Failed attempts before this one. */
  readonly attemptsMade: number;
  /** Total attempts the transport makes, when the job options carry it. */
  readonly maxAttempts: number | undefined;
  /** `true` when no further attempt follows. */
  readonly final: boolean;
  readonly error: JobErrorSummary;
}

/** Default drain deadline for `close()`: in-flight jobs get 30 seconds. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Thrown by a handler (or created by the runtime) for an error that must not
 * be retried: the attempt fails terminally regardless of attempts left.
 */
export class UnrecoverableJobError extends JsailsError {
  readonly code = 'unrecoverable';
}

/** Raised (and set as `context.signal.reason`) when an attempt exceeds its timeout. */
export class JobTimeoutError extends JsailsError {
  readonly code = 'timed_out';

  constructor(readonly jobName: string) {
    super(`job "${jobName}" exceeded its timeout`);
  }
}

const nonRetryable = new WeakSet<object>();

/**
 * Mark `error` so the adapter fails the attempt terminally. Objects keep their
 * identity; a thrown primitive is wrapped in an {@link UnrecoverableJobError}.
 * Returns the value to rethrow.
 */
export function markJobErrorNonRetryable(error: unknown): unknown {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    nonRetryable.add(error);
    return error;
  }
  return new UnrecoverableJobError('job failed with a non-error value');
}

/** Whether an adapter must fail this error terminally instead of retrying it. */
export function isJobErrorNonRetryable(error: unknown): boolean {
  if (error instanceof UnrecoverableJobError) return true;
  // BullMQ fails its own `UnrecoverableError` terminally; it is matched by
  // name so this module stays independent of the transport package.
  if (error instanceof Error && error.name === 'UnrecoverableError') return true;
  return error !== null && typeof error === 'object' && nonRetryable.has(error);
}

const interrupted = new WeakSet<object>();

/**
 * Whether the processor rejected because the runtime's shutdown aborted the
 * attempt. Such a rejection is not a failure of the job: an adapter must put
 * the job back in its queue without counting the attempt (no backoff, no
 * terminal failure), because the runtime neither reported nor recorded it.
 */
export function isJobAttemptInterrupted(error: unknown): boolean {
  return error !== null && typeof error === 'object' && interrupted.has(error);
}

/** Default failure reporter: one line per failed attempt, never the payload. */
function logJobFailure(failure: JobFailureInfo): void {
  const attempt =
    failure.maxAttempts === undefined
      ? `attempt ${failure.attemptsMade + 1}`
      : `attempt ${failure.attemptsMade + 1}/${failure.maxAttempts}`;
  const id = failure.jobId === undefined ? '' : ` (${failure.jobId})`;
  const code = failure.error.code === undefined ? '' : ` [${failure.error.code}]`;
  console.error(
    `[jsails:jobs] job "${failure.name}"${id} failed on ${attempt}` +
      `${failure.final ? '' : ', will retry'}: ${failure.error.name}${code}: ${failure.error.message}`,
  );
}

/** The attempt budget recorded in the job's options, when present. */
function readMaxAttempts(options: Record<string, unknown> | undefined): number | undefined {
  const attempts = options?.attempts;
  return typeof attempts === 'number' && Number.isInteger(attempts) && attempts > 0
    ? attempts
    : undefined;
}

/** The normalized monitoring tags a received job carries, when they are well formed. */
function readTags(options: Record<string, unknown> | undefined): readonly string[] | undefined {
  const raw = options?.[TAG_OPTION_KEY];
  if (raw === undefined) return undefined;
  try {
    const tags = normalizeTags(raw);
    return tags.length > 0 ? tags : undefined;
  } catch {
    // Tags only label the record; malformed ones are left out rather than
    // costing the failure its history entry.
    return undefined;
  }
}

/** Default reporter for a history that rejected a record: one line, no payload. */
function logRecordFailure(name: string, error: unknown): void {
  const summary = summarizeJobError(error);
  const code = summary.code === undefined ? '' : ` [${summary.code}]`;
  console.error(
    `[jsails:jobs] could not record failed job "${name}" in the failed-job history: ` +
      `${summary.name}${code}`,
  );
}

/** The provider job id from a dispatch result, when it exposes one. */
function readJobId(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const id = (result as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Validate an optional millisecond bound: an integer in `[min, max]`. */
function validateMs(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Run `work` until it settles or `signal` aborts, whichever comes first. On
 * abort the returned promise rejects with the signal's reason; the abandoned
 * work keeps running but its outcome is ignored (its rejection is observed by
 * the race, so it never becomes unhandled).
 */
function raceAbort(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason as Error);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  });
}

/** Stable failure code carried by {@link JobsRuntimeError}. */
export type JobsRuntimeErrorCode = 'unsupported_operation' | 'invalid_schedule_ids' | 'closed';

/** Raised for an invalid adapter or a runtime-level misuse. */
export class JobsRuntimeError extends JsailsError {
  constructor(
    readonly code: JobsRuntimeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Raised when an operation is attempted after {@link JobsRuntime.close}. */
export class JobsRuntimeClosedError extends JobsRuntimeError {
  constructor() {
    super('closed', 'the job runtime is closed');
  }
}

/** Options accepted by {@link JobsRuntimeImpl}. */
export interface JobsRuntimeOptions {
  /** The registry naming the jobs this runtime may dispatch and process. */
  readonly registry: JobRegistry;
  /** The transport adapter. */
  readonly adapter: JobsRuntimeAdapter;
  /** Queue name. Defaults to `"default"`. */
  readonly queueName?: string;
  /** Key prefix. Defaults to `"bull"`. */
  readonly prefix?: string;
  /** Worker concurrency. Defaults to 1. */
  readonly concurrency?: number;
  /** Per-job middleware, keyed by job name. Each array runs in declared order. */
  readonly middleware?: Readonly<Record<string, readonly JobMiddleware[]>>;
  /**
   * Optional lease store used to enforce `ScheduleDefinition.overlap` without
   * registering `createOverlapMiddleware` manually. The runtime detects the
   * scheduler's overlap descriptor in the job options and wraps the job
   * automatically. The caller owns the store; the runtime never closes it.
   */
  readonly overlapLeases?: LeaseStore;
  /**
   * Optional signal bus for job lifecycle events. When present, the runtime
   * emits `jobPushed` / `jobCompleted` / `jobFailed` / `jobRetried`; when absent
   * nothing is emitted.
   */
  readonly signals?: SignalBus;
  /**
   * Optional durable schedule-pause store. When present, `pauseSchedules`
   * persists the paused ids (making pause durable across restarts) and
   * `upsertSchedules` skips their re-registration on a later `work` start.
   * When absent, pause is non-durable: the adapter removes the schedules and
   * the next `work` start re-registers everything.
   *
   * Durability is the store's contract: an in-memory store is process-scoped;
   * a Valkey-backed {@link CachePausedScheduleStore} is multi-process.
   */
  readonly pausedSchedules?: PausedScheduleStore;
  /**
   * Default per-attempt timeout in milliseconds for jobs that declare none.
   * An attempt past its timeout fails with {@link JobTimeoutError} (and is
   * retried like any other failure) and its `context.signal` is aborted.
   * Absent means no default timeout.
   */
  readonly jobTimeoutMs?: number;
  /**
   * How long `close()` lets in-flight jobs drain before aborting them (their
   * signals fire and their attempts fail, to be retried by the transport).
   * Defaults to {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}.
   */
  readonly shutdownTimeoutMs?: number;
  /**
   * Called for every failed attempt with a payload-free summary. Defaults to a
   * one-line `console.error` report; pass `false` to silence it (for example
   * when a `jobFailed` signal listener already logs).
   */
  readonly onJobFailed?: ((failure: JobFailureInfo) => void) | false;
  /**
   * Optional failed-job history. A job that fails for the last time (its
   * attempts are spent, or the error is non-retryable) is recorded there with
   * its queue, name, payload as received, attempt count, request id, and the
   * value-free error summary. A history that rejects the record is reported on
   * stderr and never replaces the job's own error. The caller owns the
   * history; the runtime never closes it. Absent means nothing is recorded.
   */
  readonly failedJobs?: FailedJobHistory;
  /**
   * Ambient service registry borrowed from a CLI-level `runExtensions()` call.
   * When present, every job execution (handler + per-job middleware) runs with
   * it as the application scope so `facade()` calls resolve.
   * When `undefined` (the default) no scope is opened, and a `facade()` call
   * throws `FacadeError('no_app_scope')`.
   *
   * The runtime never closes or clears the registry — it is borrowed from the
   * CLI layer, which owns its lifecycle.
   */
  readonly serviceRegistry?: ServiceRegistry;
}

/** The controller returned by {@link JobsRuntimeImpl}. */
export interface JobsRuntime {
  /** Validate and enqueue a job. The result is the provider's own value. */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown>;
  /** Lazily create the worker and begin processing. */
  startWorker(): Promise<void>;
  /**
   * Cut a `close()` short: abort every in-flight attempt now (each goes back
   * to its queue without spending an attempt) and force the worker closed,
   * as the drain deadline does. Starts `close()` when it has not started.
   */
  abort(): Promise<void>;
  /**
   * Pause the queue so no new jobs are processed. Non-durable and
   * process-scoped: the provider owns the pause state, and a restarted
   * process sees the provider's own default. Requires a producer whose
   * transport supports pausing; otherwise throws {@link JobsRuntimeError}.
   */
  pauseQueue(): Promise<void>;
  /**
   * Resume a paused queue so jobs are processed again. Non-durable and
   * process-scoped: the provider owns the resume state. Requires a producer
   * whose transport supports pausing; otherwise throws {@link JobsRuntimeError}.
   */
  resumeQueue(): Promise<void>;
  /**
   * Validate and register schedules through the adapter's capability, then
   * (unless `prune: false`) remove provider schedules no longer declared.
   */
  upsertSchedules(
    schedules: readonly ScheduleDefinition[],
    options?: UpsertSchedulesOptions,
  ): Promise<void>;
  /** Read queue metrics through the producer's transport capability. */
  readCounts?(): Promise<QueueCounts>;
  /** List registered schedules through the adapter's capability. */
  listSchedules(): Promise<readonly ScheduleInfo[]>;
  /**
   * Pause (remove) the named schedules so they stop firing. Non-durable:
   * a later `work` start re-registers them. There is no `resumeSchedules`
   * runtime method — resuming is done by calling `upsertSchedules` again.
   */
  pauseSchedules(ids: readonly string[]): Promise<void>;
  /** Close the worker and producer (in that order). Idempotent. */
  close(): Promise<void>;
}

/**
 * Validate an adapter's shape — non-empty `name`, `createProducer`,
 * `createWorker`, and (when present) `upsertSchedules` — without invoking any
 * factory. Exported so config validation can reject a malformed custom adapter
 * before it ever reaches this controller; {@link JobsRuntimeImpl} reuses the same
 * check so the two never disagree about the contract.
 */
export function validateJobsRuntimeAdapter(
  adapter: unknown,
): asserts adapter is JobsRuntimeAdapter {
  if (adapter === null || typeof adapter !== 'object') {
    throw new TypeError('JobsRuntimeImpl requires a JobsRuntimeAdapter');
  }
  const name = (adapter as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('JobsRuntimeAdapter must declare a non-empty name');
  }
  if (typeof (adapter as { createProducer?: unknown }).createProducer !== 'function') {
    throw new TypeError('JobsRuntimeAdapter must declare a createProducer function');
  }
  if (typeof (adapter as { createWorker?: unknown }).createWorker !== 'function') {
    throw new TypeError('JobsRuntimeAdapter must declare a createWorker function');
  }
  const reach = (adapter as { reach?: unknown }).reach;
  if (reach !== undefined && reach !== 'process' && reach !== 'shared') {
    throw new TypeError('JobsRuntimeAdapter.reach must be process or shared when present');
  }
  const schedule = (adapter as { upsertSchedules?: unknown }).upsertSchedules;
  if (schedule !== undefined && typeof schedule !== 'function') {
    throw new TypeError('JobsRuntimeAdapter.upsertSchedules must be a function when present');
  }
  const listFn = (adapter as { listSchedules?: unknown }).listSchedules;
  if (listFn !== undefined && typeof listFn !== 'function') {
    throw new TypeError('JobsRuntimeAdapter.listSchedules must be a function when present');
  }
  const pauseFn = (adapter as { pauseSchedules?: unknown }).pauseSchedules;
  if (pauseFn !== undefined && typeof pauseFn !== 'function') {
    throw new TypeError('JobsRuntimeAdapter.pauseSchedules must be a function when present');
  }
  const removeFn = (adapter as { removeSchedules?: unknown }).removeSchedules;
  if (removeFn !== undefined && typeof removeFn !== 'function') {
    throw new TypeError('JobsRuntimeAdapter.removeSchedules must be a function when present');
  }
}

function assertProducer(producer: unknown): asserts producer is RuntimeProducer {
  if (producer === null || typeof producer !== 'object') {
    throw new TypeError('JobsRuntimeAdapter.createProducer must resolve to a producer object');
  }
  if (typeof (producer as { dispatch?: unknown }).dispatch !== 'function') {
    throw new TypeError('runtime producer must declare a dispatch function');
  }
  if (typeof (producer as { close?: unknown }).close !== 'function') {
    throw new TypeError('runtime producer must declare a close function');
  }
}

function assertWorker(worker: unknown): asserts worker is RuntimeWorker {
  if (worker === null || typeof worker !== 'object') {
    throw new TypeError('JobsRuntimeAdapter.createWorker must resolve to a worker object');
  }
  if (typeof (worker as { close?: unknown }).close !== 'function') {
    throw new TypeError('runtime worker must declare a close function');
  }
}

/** Normalize a worker concurrency: absent means 1; anything but a positive integer is `makeError()`. */
export function validateConcurrency(value: unknown, makeError: () => Error): number {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw makeError();
  }
  return value;
}

/**
 * Validate that every middleware entry is a function, throwing eagerly so a
 * non-function is caught at construction time, not at process time.
 */
function validateMiddlewareMap(
  map: Readonly<Record<string, readonly JobMiddleware[]>> | undefined,
): Readonly<Record<string, readonly JobMiddleware[]>> | undefined {
  if (map === undefined) {
    return undefined;
  }
  for (const mws of Object.values(map)) {
    for (const mw of mws) {
      if (typeof mw !== 'function') {
        throw new JobMiddlewareError(
          'invalid_middleware',
          'job middleware entries must be functions',
        );
      }
    }
  }
  return map;
}

/** Validate the optional automatic-overlap store without touching it. */
function validateOverlapLeases(value: unknown): LeaseStore | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isLeaseStore(value)) {
    throw new TypeError('overlapLeases must implement acquire/renew/release/close');
  }
  return value;
}

/** Per-runtime processing settings handed to {@link makeProcessJob}. */
interface ProcessSettings {
  readonly registry: JobRegistry;
  readonly dispatch: (name: string, payload: unknown, opts?: unknown) => Promise<unknown>;
  readonly middleware: Readonly<Record<string, readonly JobMiddleware[]>> | undefined;
  readonly signals: SignalBus | undefined;
  readonly serviceRegistry: ServiceRegistry | undefined;
  readonly overlapLeases: LeaseStore | undefined;
  readonly jobTimeoutMs: number | undefined;
  readonly onJobFailed: ((failure: JobFailureInfo) => void) | undefined;
  readonly failedJobs: FailedJobHistory | undefined;
  readonly queueName: string;
  /** In-flight attempts, aborted when `close()` passes its drain deadline. */
  readonly active: Set<AbortController>;
}

/** Whether `signal` was aborted by the runtime's own shutdown drain deadline. */
function abortedByShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof JobsRuntimeClosedError;
}

/**
 * Build the processor: reject an unknown job, validate the payload, then
 * compose any per-job middleware around the handler. Unknown-job rejection and
 * payload validation always run BEFORE middleware, so a bad payload never
 * reaches a middleware function; both fail terminally, since a retry cannot
 * fix them.
 */
function makeProcessJob(settings: ProcessSettings): ProcessJob {
  const { registry, dispatch, middleware, signals, overlapLeases, serviceRegistry } = settings;
  // When a service registry is supplied, every job execution (handler +
  // middleware) runs with it as the application scope so `facade()` calls
  // resolve. The registry is borrowed — the runtime never closes or clears it.
  const scope = serviceRegistry === undefined ? [] : [appScopeEntry(serviceRegistry)];

  const emit = (event: typeof jobFailed, payload: JobEventPayload): void => {
    if (signals) {
      signals.emit(event, payload).catch(() => {
        // A job event is a notification; observer failure never changes the job outcome.
      });
    }
  };

  const runJob = async (
    job: RuntimeJob,
    controller: AbortController,
    isFinalFailure: (error: unknown) => boolean,
    requestId: string | undefined,
  ): Promise<unknown> => {
    const definition = registry[job.name];
    if (definition === undefined) {
      throw markJobErrorNonRetryable(new JobNotRegisteredError(job.name));
    }
    let data: unknown;
    try {
      data = validatePayload(definition.schema, job.name, job.data);
    } catch (error) {
      throw markJobErrorNonRetryable(error);
    }
    const context: JobContext = {
      jobId: job.id,
      name: job.name,
      attemptsMade: job.attemptsMade,
      attemptsStarted: job.attemptsStarted,
      ...(requestId === undefined ? {} : { requestId }),
      log: (message) => job.log(message).then(() => undefined),
      updateProgress: (progress) => job.updateProgress(progress),
      dispatch: (name, payload, opts) => dispatch(name, payload, opts),
      signal: controller.signal,
    };
    const timeoutMs = jobTimeout(definition) ?? settings.jobTimeoutMs;

    const handleWithPolicy = async (handlerData: unknown): Promise<void> => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => controller.abort(new JobTimeoutError(job.name)), timeoutMs);
      try {
        const run = async (): Promise<void> => {
          if (typeof definition === 'function') {
            const instance = new definition(context);
            await instance.handle(handlerData);
          } else {
            await definition.handler(handlerData, context);
          }
        };
        await raceAbort(run(), controller.signal);
        emit(jobCompleted, { name: job.name, jobId: job.id });
      } catch (error) {
        // A shutdown abort is not the job's error, so no policy may judge it:
        // `retryOn` would turn it into a terminal failure and `discardOn` into
        // a completion, either way losing a job that never finished.
        if (abortedByShutdown(controller.signal)) throw error;
        // Per-job error policy (the `retry_on`/`discard_on` analog), evaluated
        // before the transport sees the error: `discardOn` swallows the throw
        // as a successful completion; `retryOn` returning false makes the
        // failure terminal.
        const policy = jobPolicy(definition);
        if (policy?.discardOn !== undefined && policy.discardOn(error, context)) {
          emit(jobCompleted, { name: job.name, jobId: job.id });
          return;
        }
        if (policy?.retryOn !== undefined && !policy.retryOn(error, context)) {
          throw markJobErrorNonRetryable(error);
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    const jobMiddleware = middleware?.[job.name] ?? [];
    const options =
      job.opts !== null && typeof job.opts === 'object'
        ? (job.opts as Record<string, unknown>)
        : undefined;
    const automaticOverlap =
      overlapLeases !== undefined &&
      isOverlapDescriptor(options?.[OVERLAP_OPTION_KEY]) &&
      !jobMiddleware.some((entry) => isOverlapMiddleware(entry))
        ? [createOverlapMiddleware(overlapLeases)]
        : [];
    const composedMiddleware =
      automaticOverlap.length > 0 ? [...automaticOverlap, ...jobMiddleware] : jobMiddleware;

    if (composedMiddleware.length > 0) {
      const mwContext: JobMiddlewareContext = {
        name: job.name,
        jobId: job.id,
        options: job.opts,
        attemptsMade: job.attemptsMade,
        isFinalFailure,
        signal: controller.signal,
        dispatch: (name, payload, opts) => dispatch(name, payload, opts),
      };
      const composed = composeMiddleware(composedMiddleware, async (mwData, _mwCtx) => {
        await handleWithPolicy(mwData);
      });
      return composed(data, mwContext);
    }

    return handleWithPolicy(data);
  };

  const attempt = async (
    job: RuntimeJob,
    requestId: string | undefined,
    restoreError: unknown,
  ): Promise<unknown> => {
    const options =
      job.opts !== null && typeof job.opts === 'object'
        ? (job.opts as Record<string, unknown>)
        : undefined;
    const maxAttempts = readMaxAttempts(options);
    const controller = new AbortController();
    // Without a recorded budget the runtime cannot know a retry follows, so it
    // reports the failure as final (the conservative reading for batching).
    // An attempt the shutdown aborted is never final: the processor rejects
    // with an interrupted marker, and the adapter puts the job back in its
    // queue without counting the attempt.
    const isFinalFailure = (error: unknown): boolean =>
      !abortedByShutdown(controller.signal) &&
      (isJobErrorNonRetryable(error) ||
        maxAttempts === undefined ||
        job.attemptsMade + 1 >= maxAttempts);
    settings.active.add(controller);
    try {
      if (restoreError !== undefined) throw restoreError;
      return await runJob(job, controller, isFinalFailure, requestId);
    } catch (error) {
      // A shutdown abort is not a failure of the job: reporting it would log
      // and signal a failure, and recording it would put a job into the
      // failed history that the transport is about to run again (so a
      // `queue:retry` would run it twice). The abort reason is rethrown
      // whatever the handler or a middleware threw instead, marked so the
      // adapter requeues the job without spending an attempt.
      if (abortedByShutdown(controller.signal)) {
        const reason = controller.signal.reason as JobsRuntimeClosedError;
        interrupted.add(reason);
        throw reason;
      }
      const final = isFinalFailure(error);
      const summary = summarizeJobError(error);
      emit(jobFailed, {
        name: job.name,
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        final,
        error: summary,
      });
      if (!final) {
        emit(jobRetried, { name: job.name, jobId: job.id, attemptsMade: job.attemptsMade });
      }
      if (settings.onJobFailed !== undefined) {
        try {
          settings.onJobFailed({
            name: job.name,
            jobId: job.id,
            attemptsMade: job.attemptsMade,
            maxAttempts,
            final,
            error: summary,
          });
        } catch {
          // A failing reporter must not replace the job's own error.
        }
      }
      if (final && settings.failedJobs !== undefined) {
        const tags = readTags(options);
        const replayOptions = replayableJobOptions(options);
        const membership = jobMembership(options);
        try {
          await settings.failedJobs.record({
            queue: settings.queueName,
            name: job.name,
            data: job.data,
            error: summary,
            attempts: job.attemptsMade + 1,
            failedAt: new Date(),
            ...(requestId === undefined ? {} : { requestId }),
            ...(tags === undefined ? {} : { tags }),
            ...(replayOptions === undefined ? {} : { options: replayOptions }),
            ...(membership === undefined ? {} : { membership }),
          });
        } catch (recordError) {
          logRecordFailure(job.name, recordError);
        }
      }
      throw error;
    } finally {
      settings.active.delete(controller);
    }
  };

  // The whole attempt, its failure reporting included, replaces whatever
  // context the adapter started it in with its own: the dispatcher's request
  // id, trace, locale, and tenant reach the handler, its logs and error
  // reports, the failure signals and history, and any job it dispatches, and
  // nothing of an unrelated caller (a request whose dispatch pumped an
  // in-memory queue, the previous job, a timer) does. A carrier that does not
  // restore leaves the attempt a fresh context, so its failure is reported
  // with no tenant rather than the caller's.
  return (job) => {
    let context: ExecutionContext;
    let restoreError: unknown;
    try {
      context = jobExecutionContext(job.opts, scope);
    } catch (error) {
      context = createExecutionContext({ values: scope });
      restoreError = error;
    }
    return runInContext(context, () => attempt(job, context.requestId, restoreError));
  };
}

/**
 * Provider-neutral jobs runtime. Nothing connects or starts until the first
 * `dispatch`/`startWorker`/`upsertSchedules` call; the adapter's handles are
 * created lazily and reused thereafter.
 */
export class JobsRuntimeImpl implements JobsRuntime {
  readonly #registry: JobRegistry;
  readonly #adapter: JobsRuntimeAdapter;
  readonly #middleware: Readonly<Record<string, readonly JobMiddleware[]>> | undefined;
  readonly #signals: SignalBus | undefined;
  readonly #pausedSchedules: PausedScheduleStore | undefined;
  readonly #serviceRegistry: ServiceRegistry | undefined;
  readonly #context: JobAdapterContext;
  readonly #shutdownTimeoutMs: number;
  /** Set by {@link abort}: the close skips its drain. */
  #aborted = false;
  /** While a close drains the worker: stop it now. */
  #forceStop: (() => void) | undefined;
  readonly #active = new Set<AbortController>();
  #closed = false;
  #producerPromise: Promise<RuntimeProducer> | undefined;
  #workerPromise: Promise<RuntimeWorker> | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #processJob: ProcessJob;

  constructor(options: JobsRuntimeOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('JobsRuntimeImpl requires an options object');
    }
    const {
      registry,
      adapter,
      middleware: middlewareMap,
      signals,
      pausedSchedules,
      serviceRegistry,
      overlapLeases,
    } = options;
    if (registry === null || typeof registry !== 'object') {
      throw new TypeError('JobsRuntimeImpl requires a job registry');
    }
    validateJobsRuntimeAdapter(adapter);
    const validatedOverlapLeases = validateOverlapLeases(overlapLeases);

    this.#registry = registry;
    this.#adapter = adapter;
    this.#middleware = validateMiddlewareMap(middlewareMap);
    this.#signals = signals;
    this.#pausedSchedules = pausedSchedules;
    this.#serviceRegistry = serviceRegistry;

    this.#context = {
      queueName: options.queueName ?? DEFAULT_QUEUE_NAME,
      prefix: options.prefix ?? DEFAULT_PREFIX,
      concurrency: validateConcurrency(
        options.concurrency,
        () => new TypeError('concurrency must be a positive integer'),
      ),
      registry,
    };

    const jobTimeoutMs = validateMs(options.jobTimeoutMs, 'jobTimeoutMs', 1, MAX_JOB_TIMEOUT_MS);
    this.#shutdownTimeoutMs =
      validateMs(options.shutdownTimeoutMs, 'shutdownTimeoutMs', 0, MAX_JOB_TIMEOUT_MS) ??
      DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const { onJobFailed } = options;
    if (onJobFailed !== undefined && onJobFailed !== false && typeof onJobFailed !== 'function') {
      throw new TypeError('onJobFailed must be a function or false');
    }
    const { failedJobs } = options;
    if (failedJobs !== undefined && !isFailedJobHistory(failedJobs)) {
      throw new TypeError('failedJobs must implement record/list/get/remove/take/restore/clear');
    }

    this.#processJob = makeProcessJob({
      registry,
      dispatch: (name, payload, opts) => this.#dispatch(name, payload, opts),
      middleware: this.#middleware,
      signals,
      serviceRegistry: this.#serviceRegistry,
      overlapLeases: validatedOverlapLeases,
      jobTimeoutMs,
      onJobFailed: onJobFailed === false ? undefined : (onJobFailed ?? logJobFailure),
      failedJobs,
      queueName: this.#context.queueName,
      active: this.#active,
    });
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new JobsRuntimeClosedError();
    }
  }

  async #createProducerHandle(): Promise<RuntimeProducer> {
    const producer = await this.#adapter.createProducer(this.#context);
    assertProducer(producer);
    return producer;
  }

  async #createWorkerHandle(): Promise<RuntimeWorker> {
    const worker = await this.#adapter.createWorker(this.#context, this.#processJob);
    assertWorker(worker);
    return worker;
  }

  #ensureProducer(): Promise<RuntimeProducer> {
    this.#assertOpen();
    if (this.#producerPromise === undefined) {
      const pending = this.#createProducerHandle();
      this.#producerPromise = pending;
      // A failed start must not wedge the runtime: clear the cache so a later
      // operation can retry. The adapter owns cleanup of partial resources.
      pending.catch(() => {
        if (this.#producerPromise === pending) {
          this.#producerPromise = undefined;
        }
      });
    }
    return this.#producerPromise;
  }

  async #dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown> {
    this.#assertOpen();
    const definition = this.#registry[name];
    if (definition === undefined) {
      throw new JobNotRegisteredError(name);
    }
    const data = validatePayload(definition.schema, name, payload);
    const dispatchOptions: JobDispatchOptions = { ...validateJobOptions(opts) };
    // Set by the runtime, never by the caller: the allowlist rejects the key
    // in `opts`, so a stored carrier always describes the dispatching context.
    const carrier = serializeContext();
    if (carrier !== undefined) dispatchOptions[CONTEXT_OPTION_KEY] = carrier;
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    const result = await producer.dispatch(name, data, dispatchOptions);
    if (this.#signals) {
      this.#signals.emit(jobPushed, { name, jobId: readJobId(result) }).catch(() => {
        // A job event is a notification; observer failure never fails the dispatch.
      });
    }
    return result;
  }

  async startWorker(): Promise<void> {
    this.#assertOpen();
    if (this.#workerPromise === undefined) {
      const pending = this.#createWorkerHandle();
      this.#workerPromise = pending;
      pending.catch(() => {
        if (this.#workerPromise === pending) {
          this.#workerPromise = undefined;
        }
      });
    }
    await this.#workerPromise;
    this.#assertOpen();
  }

  async upsertSchedules(
    schedules: readonly ScheduleDefinition[],
    options?: UpsertSchedulesOptions,
  ): Promise<void> {
    this.#assertOpen();
    const schedule = this.#adapter.upsertSchedules;
    if (schedule === undefined) {
      throw new JobsRuntimeError(
        'unsupported_operation',
        `job adapter "${this.#adapter.name}" does not support scheduling`,
      );
    }

    // Validate the whole declared list (paused ones included) before any
    // store or provider call, so a bad entry never leaves a partial write.
    prepareSchedules(this.#registry, schedules);

    // When a durable pause store is present, skip re-registering schedules
    // that are paused. Pause state is read per-id (up to one store call per
    // schedule) — the caller owns the schedule count (bounded by
    // MAX_SCHEDULES), so this is a bounded scan, not an unbounded fan-out.
    let toRegister: readonly ScheduleDefinition[] = schedules;
    if (this.#pausedSchedules !== undefined) {
      const pausedIds = new Set<string>();
      for (const s of schedules) {
        if (await this.#pausedSchedules.isPaused(s.id)) {
          pausedIds.add(s.id);
        }
      }
      if (pausedIds.size > 0) {
        toRegister = schedules.filter((s) => !pausedIds.has(s.id));
      }
    }

    const prepared = prepareSchedules(this.#registry, toRegister);
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    await schedule.call(this.#adapter, producer, prepared);

    if (options?.prune !== false) {
      await this.#pruneSchedules(producer, new Set(schedules.map((entry) => entry.id)));
    }
  }

  /**
   * Remove provider schedules whose ids are not declared. Declared-but-paused
   * ids are kept out of the provider by pause itself, so they are never in the
   * stale set. A no-op unless the adapter can both list and remove schedules.
   */
  async #pruneSchedules(producer: RuntimeProducer, declared: ReadonlySet<string>): Promise<void> {
    const listFn = this.#adapter.listSchedules;
    const removeFn = this.#adapter.removeSchedules;
    if (listFn === undefined || removeFn === undefined) {
      return;
    }
    const registered = await listFn.call(this.#adapter, producer);
    const stale = registered.map((entry) => entry.id).filter((id) => !declared.has(id));
    if (stale.length > 0) {
      await removeFn.call(this.#adapter, producer, stale);
    }
  }

  async readCounts(): Promise<QueueCounts> {
    this.#assertOpen();
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    if (typeof producer.readCounts !== 'function') {
      throw new JobsRuntimeError(
        'unsupported_operation',
        `job adapter "${this.#adapter.name}" does not support queue metrics`,
      );
    }
    return producer.readCounts();
  }

  async pauseQueue(): Promise<void> {
    this.#assertOpen();
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    if (typeof producer.pause !== 'function') {
      throw new JobsRuntimeError(
        'unsupported_operation',
        `job adapter "${this.#adapter.name}" does not support pausing the queue`,
      );
    }
    await producer.pause();
  }

  async resumeQueue(): Promise<void> {
    this.#assertOpen();
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    if (typeof producer.resume !== 'function') {
      throw new JobsRuntimeError(
        'unsupported_operation',
        `job adapter "${this.#adapter.name}" does not support resuming the queue`,
      );
    }
    await producer.resume();
  }

  async listSchedules(): Promise<readonly ScheduleInfo[]> {
    this.#assertOpen();
    const listFn = this.#adapter.listSchedules;
    if (listFn === undefined) {
      throw new JobsRuntimeError(
        'unsupported_operation',
        `job adapter "${this.#adapter.name}" does not support listing schedules`,
      );
    }
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    return listFn.call(this.#adapter, producer);
  }

  async pauseSchedules(ids: readonly string[]): Promise<void> {
    this.#assertOpen();
    const pauseFn = this.#adapter.pauseSchedules;
    if (pauseFn === undefined) {
      throw new JobsRuntimeError(
        'unsupported_operation',
        `job adapter "${this.#adapter.name}" does not support pausing schedules`,
      );
    }
    if (!Array.isArray(ids)) {
      throw new JobsRuntimeError(
        'invalid_schedule_ids',
        'pauseSchedules ids must be an array of non-empty strings',
      );
    }
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new JobsRuntimeError(
          'invalid_schedule_ids',
          'pauseSchedules ids must be an array of non-empty strings',
        );
      }
    }
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    await pauseFn.call(this.#adapter, producer, ids);

    // Persist paused state when a store is configured so a later `work` start
    // (which calls `upsertSchedules`) skips re-registration. A store error
    // propagates — the adapter already removed the schedule, so the caller
    // sees a partial outcome and can retry the store write.
    if (this.#pausedSchedules !== undefined) {
      await this.#pausedSchedules.setPaused(ids);
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async abort(): Promise<void> {
    this.#aborted = true;
    const closing = this.close();
    this.#forceStop?.();
    await closing;
  }

  async #performClose(): Promise<void> {
    let firstError: unknown;
    const worker = await resolveHandle(this.#workerPromise);
    if (worker !== undefined) {
      // Drain in-flight jobs up to the deadline (or an abort), then abort
      // them: the adapter puts each one back in its queue without spending an
      // attempt, so the worker's own graceful close can finish instead of
      // waiting on a hung handler.
      let forced = false;
      const forceStop = (): void => {
        if (forced) return;
        forced = true;
        for (const controller of this.#active) {
          controller.abort(new JobsRuntimeClosedError());
        }
        worker.close(true).catch(() => {
          // The graceful close below reports the shutdown outcome.
        });
      };
      this.#forceStop = forceStop;
      const deadline = setTimeout(forceStop, this.#shutdownTimeoutMs);
      if (this.#aborted) forceStop();
      try {
        await worker.close();
      } catch (error) {
        firstError = error;
      } finally {
        clearTimeout(deadline);
        this.#forceStop = undefined;
      }
    }
    const producer = await resolveHandle(this.#producerPromise);
    if (producer !== undefined) {
      try {
        await producer.close();
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
        }
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  /** Public accessor for dispatch, used by createJobChain / middleware contexts. */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown> {
    return this.#dispatch(name, payload, opts);
  }
}

/**
 * Await a lazily created handle, swallowing a creation failure: a handle that
 * could not be created has nothing to close.
 */
async function resolveHandle<T>(promise: Promise<T> | undefined): Promise<T | undefined> {
  if (promise === undefined) {
    return undefined;
  }
  try {
    return await promise;
  } catch {
    return undefined;
  }
}
