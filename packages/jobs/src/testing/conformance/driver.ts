/**
 * The driver interface the conformance suite runs against.
 *
 * A scenario never touches an adapter or a runtime directly. It defines jobs
 * as neutral {@link ScenarioJob} values, then drives a {@link JobsHarnessDriver}
 * that maps each operation onto one concrete implementation (today's
 * `jsails/jobs` runtime, the new runtime, or a third-party adapter). Every
 * assertion is about observed behaviour: which handlers ran, with what, how
 * often, and which events the implementation reported.
 *
 * The model is two processes over one shared transport: a producer that
 * dispatches and owns flow callbacks, and workers that process. Operations
 * that a process restart or a transport redelivery would cause
 * ({@link JobsHarnessDriver.restartProducer}, {@link JobsHarnessDriver.redeliver})
 * are explicit so at-least-once behaviour can be tested deterministically.
 */

import type { BatchStatus, FailedJob, JobHandle, RetryResult } from '../../contract/index.js';

/** A job to run: a name and a JSON payload. */
export interface ScenarioCall {
  readonly name: string;
  readonly payload: unknown;
}

/** The dispatch options a scenario may use. */
export interface ScenarioDispatchOptions {
  readonly key?: string;
  readonly keyWindowMs?: number;
  readonly delayMs?: number;
  readonly tags?: readonly string[];
}

/** What a handler sees. */
export interface ScenarioJobContext {
  /** The transport's id for this job; the same across redeliveries and retries of it. */
  readonly jobId: string;
  /** One-based attempt number. A released attempt is not counted. */
  readonly attempt: number;
  readonly signal: AbortSignal;
  dispatch(call: ScenarioCall, options?: ScenarioDispatchOptions): Promise<JobHandle>;
}

/** Definition middleware: wraps the handler, outermost first. */
export type ScenarioMiddleware = (
  context: { readonly name: string; readonly signal: AbortSignal },
  next: () => Promise<void>,
) => Promise<void>;

/** A job definition in neutral form. */
export interface ScenarioJob {
  readonly name: string;
  /** Total attempts, the first run included. Defaults to 1. */
  readonly attempts?: number;
  /** Payload validation; a rejected payload is refused at dispatch. Defaults to accepting any. */
  readonly accepts?: (payload: unknown) => boolean;
  /** The job never runs alongside another run holding the same key; such a run is skipped. */
  readonly overlap?: { readonly key: string; readonly ttlMs: number };
  readonly middleware?: ScenarioMiddleware;
  handle(payload: unknown, context: ScenarioJobContext): Promise<void>;
}

/** A running worker. */
export interface WorkerHandle {
  readonly id: string;
}

export interface StartWorkerOptions {
  /** Defaults to 1. */
  readonly concurrency?: number;
  /**
   * The job names this worker's release knows. Defaults to every defined job.
   * A narrower set models a worker of another release during a rolling deploy.
   */
  readonly knows?: readonly string[];
}

/** Flow callbacks: each is a job dispatched when the batch settles. */
export interface ScenarioBatchCallbacks {
  readonly then?: ScenarioCall;
  readonly catch?: ScenarioCall;
  readonly finally?: ScenarioCall;
}

/** An interval schedule. */
export interface ScenarioSchedule {
  readonly id: string;
  readonly call: ScenarioCall;
  readonly everyMs: number;
}

/** An outcome the implementation reported for one attempt. */
export interface JobEvent {
  readonly kind: 'completed' | 'failed' | 'skipped' | 'released';
  readonly name: string;
  readonly jobId: string | undefined;
}

/** How the suite configures a driver for one scenario. */
export interface DriverOptions {
  /** How long a drain waits for in-flight attempts before aborting them. */
  readonly drainDeadlineMs: number;
  /** Whether time only moves through {@link JobsHarnessDriver.advance}. */
  readonly virtualTime: boolean;
}

/** One concrete implementation, as the suite drives it. */
export interface JobsHarnessDriver {
  /** Register every job the scenario uses. Called once, before anything else. */
  define(jobs: readonly ScenarioJob[]): void;
  dispatch(call: ScenarioCall, options?: ScenarioDispatchOptions): Promise<JobHandle>;
  /** Run the steps in order, each after the previous one completed. */
  chain(steps: readonly ScenarioCall[]): Promise<JobHandle>;
  /** Run the items in parallel; the callbacks fire once when every item settled. */
  batch(
    items: readonly ScenarioCall[],
    callbacks: ScenarioBatchCallbacks,
  ): Promise<{ readonly id: string }>;
  batchStatus(id: string): Promise<BatchStatus | undefined>;
  startWorker(options?: StartWorkerOptions): Promise<WorkerHandle>;
  /** Stop fetching and let in-flight attempts finish up to the drain deadline. */
  drain(worker: WorkerHandle): Promise<void>;
  /** Stop fetching and abort in-flight attempts now. */
  abort(worker: WorkerHandle): Promise<void>;
  /** Deliver a job that already ran once more, as a transport does after a lost lock. */
  redeliver(jobId: string): Promise<void>;
  /** Remove completed jobs from the transport, as retention does. */
  evictCompleted(): Promise<void>;
  /** Replace the producer process: what it held only in memory is gone. */
  restartProducer(): Promise<void>;
  failed(): Promise<readonly FailedJob[]>;
  retry(id: string): Promise<RetryResult>;
  /** Make the declared set the whole set, as a release does. */
  reconcileSchedules(schedules: readonly ScenarioSchedule[]): Promise<void>;
  pauseSchedule(id: string): Promise<void>;
  /** Move virtual time forward. Only called when the driver runs with `virtualTime`. */
  advance(ms: number): Promise<void>;
  /** Resolve once nothing is runnable right now. */
  settle(): Promise<void>;
  events(): readonly JobEvent[];
  /** Release everything the driver holds. */
  close(): Promise<void>;
}

/** Builds a fresh driver for one scenario. */
export type DriverFactory = (
  options: DriverOptions,
) => JobsHarnessDriver | Promise<JobsHarnessDriver>;
