/**
 * The transport contract. An adapter stores envelopes, hands them to a worker
 * one attempt at a time, and owns attempt counting and lock tokens; job-level
 * policy (validation, outcomes, flows, context) belongs to the runtime.
 *
 * Optional behaviour is expressed as capabilities rather than optional
 * methods, so the runtime and the conformance suite can tell "unsupported"
 * from "broken". `reach` states whether producer and worker may live in
 * different processes: a `process` adapter (the in-memory one) only works when
 * both run in one process, and the kernel refuses to split them over it.
 */

import type { JobEnvelope, JobHandle } from './envelope.js';
import type { AttemptOutcome, JobErrorSummary } from './outcome.js';

/**
 * One delivery of a job to a worker. `envelope` is what the transport stored;
 * the processor decodes it before trusting any field, since a worker of an
 * older release may meet an envelope version it does not know.
 */
export interface TransportJob {
  readonly id: string;
  readonly queue: string;
  readonly envelope: JobEnvelope;
  /** Failed attempts before this delivery. A released attempt is not counted. */
  readonly attemptsMade: number;
  /** Times a worker released this job as `unknown_job` before this delivery. */
  readonly unknownReleases: number;
}

/** Processes one delivery. Total: it resolves with an outcome and never rejects. */
export type ProcessJob = (job: TransportJob, signal: AbortSignal) => Promise<AttemptOutcome>;

/** Emitted once per settled attempt. `final` is decided by the adapter. */
export interface SettleEvent {
  readonly job: TransportJob;
  readonly outcome: AttemptOutcome;
  /** True when no further attempt follows (completed, discarded, or out of attempts). */
  readonly final: boolean;
}

export interface WorkerOptions {
  readonly queues: readonly string[];
  /**
   * Attempts in flight at once, per queue. Defaults to each queue's declared
   * {@link QueueDeclaration.concurrency}.
   */
  readonly concurrency?: number;
  readonly onSettle?: (event: SettleEvent) => void;
}

/** A running worker. */
export interface AdapterWorker {
  /** Stop fetching and wait for in-flight attempts to settle. */
  drain(): Promise<void>;
  /** Stop fetching, abort in-flight attempts, release what is still held, then close. */
  abort(): Promise<void>;
}

/** Counts of one batch, read in one operation. */
export interface BatchStatus {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
  readonly settled: boolean;
  /** Children retried after the batch settled; they never re-fire its callbacks. */
  readonly retriedAfterSettlement: number;
}

/** Batches as a transport flow whose finalizer is itself a job. */
export interface FlowTransport {
  enqueueBatch(batch: {
    readonly id: string;
    readonly children: readonly JobEnvelope[];
    readonly finalizer: JobEnvelope;
    readonly chunked?: boolean;
  }): Promise<void>;
  batchStatus(id: string): Promise<BatchStatus | undefined>;
  childFailures(
    id: string,
    limit: number,
  ): Promise<readonly { readonly name: string; readonly error: JobErrorSummary }[]>;
}

/** A job that failed for the last time, as the transport keeps it. */
export interface FailedJob {
  readonly id: string;
  readonly queue: string;
  readonly envelope: JobEnvelope;
  readonly error: JobErrorSummary;
  readonly failedAt: number;
}

export type RetryResult = 'retried' | 'not_found' | 'not_failed' | 'not_retryable';

/** Failed jobs live only in the transport; a retry re-runs the same envelope. */
export interface FailedJobsCapability {
  list(options?: {
    readonly queue?: string;
    readonly limit?: number;
    readonly before?: string;
  }): Promise<readonly FailedJob[]>;
  get(id: string): Promise<FailedJob | undefined>;
  retry(id: string, options?: { readonly force?: boolean }): Promise<RetryResult>;
  remove(id: string): Promise<boolean>;
  prune(options: { readonly olderThanMs: number }): Promise<number>;
}

/** A schedule as the transport stores it. */
export interface StoredSchedule {
  readonly id: string;
  readonly queue: string;
  readonly envelope: JobEnvelope;
  readonly repeat: { readonly everyMs: number } | { readonly cron: string; readonly tz: string };
  readonly paused: boolean;
}

/** Who last reconciled a namespace's schedules. */
export interface ReconcileStamp {
  readonly app: string;
  readonly fingerprint: string;
  readonly appliedAt: number;
  readonly by: string;
}

/** Schedules are reconciled as a whole; pause state lives in the stored record. */
export interface ScheduleCapability {
  list(): Promise<readonly StoredSchedule[]>;
  upsert(schedules: readonly StoredSchedule[], stamp: ReconcileStamp): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  setPaused(ids: readonly string[], paused: boolean): Promise<void>;
  stamp(): Promise<ReconcileStamp | undefined>;
}

/** Owner-token leases for overlap control. */
export interface LeaseCapability {
  acquire(key: string, ttlMs: number): Promise<string | undefined>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<boolean>;
}

export interface JobsAdapterCapabilities {
  readonly flows?: FlowTransport;
  readonly failedJobs?: FailedJobsCapability;
  readonly schedules?: ScheduleCapability;
  readonly leases?: LeaseCapability;
}

/** How long a queue keeps settled jobs: whichever bound is reached first evicts. */
export interface RetentionRule {
  readonly ageMs: number;
  readonly count: number;
}

/** One declared queue, normalized (`src/queues/` builds it from the app's declaration). */
export interface QueueDeclaration {
  readonly name: string;
  readonly concurrency: number;
  readonly retention: {
    readonly completed: RetentionRule;
    readonly failed: RetentionRule;
  };
}

/** What an adapter is built for: one app environment and its declared queues. */
export interface JobsAdapterContext {
  /** `<app>:<environment>`; a shared transport keeps every key under it. */
  readonly namespace: string;
  readonly queues: readonly QueueDeclaration[];
}

/** Builds the adapter once the app's namespace and queues are known. */
export type JobsAdapterFactory = (
  context: JobsAdapterContext,
) => JobsAdapter | Promise<JobsAdapter>;

/** A job transport. */
export interface JobsAdapter {
  /** Diagnostic label, never used for identity or routing. */
  readonly name: string;
  readonly reach: 'process' | 'shared';
  readonly capabilities: JobsAdapterCapabilities;
  /**
   * Store one envelope on a declared `queue`, runnable from `meta.runAt` on.
   * A `meta.key` already taken on that queue inside its window stores nothing
   * and returns the first job's id with `deduplicated: true`, whatever state
   * the first job is in, evicted included.
   */
  enqueue(queue: string, envelope: JobEnvelope): Promise<JobHandle>;
  startWorker(options: WorkerOptions, process: ProcessJob): Promise<AdapterWorker>;
  close(): Promise<void>;
}
