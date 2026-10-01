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

/**
 * Processes one delivery. Total: it resolves with an outcome and never
 * rejects. `signal` aborts only when this worker shuts down (`abort()`,
 * `close()`); a processor treats its abort as shutdown. The returned promise
 * settles only after the attempt's own code (middleware, handler) has
 * settled, so a job the adapter holds until then never runs alongside an
 * attempt of itself.
 *
 * The adapter applies the outcome in one operation: it settles the job and
 * stores the outcome's `followUps` as `JobsAdapter.enqueue` would (a key
 * taken inside its window stores nothing), the follow-ups of a failure that
 * is not final excepted. A follow-up whose envelope does not decode, or that
 * names a queue the adapter was not given, makes it apply
 * `PROCESSOR_BROKE_CONTRACT` instead.
 */
export type ProcessJob = (job: TransportJob, signal: AbortSignal) => Promise<AttemptOutcome>;

/** Where a job that failed for good can be found: present on a final failure the transport kept. */
export interface FailedJobRef {
  readonly id: string;
  readonly queue: string;
}

/** Emitted once per settled attempt. `final` is decided by the adapter. */
export interface SettleEvent {
  readonly job: TransportJob;
  /** The outcome the adapter applied. */
  readonly outcome: AttemptOutcome;
  /** True when no further attempt follows (completed, discarded, skipped, or out of attempts). */
  readonly final: boolean;
  /** Set when a final failure is in the failed set once the settle applied: not dropped, not evicted by retention. */
  readonly failedJob: FailedJobRef | undefined;
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

/**
 * A running worker. An adapter never releases a job whose processor has not
 * settled: the job keeps its slot and its lock (renewed, for a transport
 * whose locks expire) until then, or until the process exits. Bounding how
 * long a caller waits for that is the runtime's job (`RuntimeWorker.abort`),
 * not the adapter's. `abort()` may follow `drain()`, and both are idempotent.
 */
export interface AdapterWorker {
  /**
   * Stop fetching now, and resolve once every in-flight attempt's processor
   * has settled and its outcome is applied.
   */
  drain(): Promise<void>;
  /**
   * Stop fetching and abort every in-flight signal before returning the
   * promise (synchronously), then resolve once every in-flight processor has
   * settled and its outcome is applied.
   */
  abort(): Promise<void>;
}

/** Counts of one batch, read in one operation. */
export interface BatchStatus {
  readonly total: number;
  /** Children whose recorded final outcome is completed or discarded. */
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
  /** `total` less the children with a recorded final outcome. */
  readonly pending: number;
  readonly settled: boolean;
  /** Children retried after the batch settled; they never re-fire its callbacks. */
  readonly retriedAfterSettlement: number;
}

/** A batch child whose recorded final outcome is a failure. */
export interface BatchChildFailure {
  readonly index: number;
  /** The child's job name, as its envelope states it. */
  readonly name: string;
  readonly error: JobErrorSummary;
}

/** One batch as the producer hands it to the transport. */
export interface BatchEnqueue {
  readonly id: string;
  /** Child `i` carries `meta.flow` `{ kind: 'batch', id, index: i }`. */
  readonly children: readonly { readonly queue: string; readonly envelope: JobEnvelope }[];
  /** Held until every child has a recorded final outcome, then runnable once. */
  readonly finalizer: { readonly queue: string; readonly envelope: JobEnvelope };
  readonly chunked: boolean;
}

/**
 * Batches, kept by the transport so they survive a producer restart.
 *
 * - `enqueueBatch` with `chunked: false` is atomic: every child and the
 *   finalizer are stored, or none. Children are runnable at once; the
 *   finalizer is held. An id already stored is a no-op that resolves
 *   `{ deduplicated: true }`; a chunked call then stores only the children
 *   not yet stored, by index. A different `children.length` for a stored id
 *   rejects with `jobs.flow_conflict`, and so does a new id one of whose
 *   children has a key another job holds on its queue, storing nothing.
 * - Children: 1 to 1,000 (`chunked: false`) or 1 to 100,000
 *   (`chunked: true`), otherwise `jobs.invalid_flow`. A child whose
 *   `meta.flow` is not `{ kind: 'batch', id, index }` at its position, or a
 *   finalizer with a key or a flow, rejects with `jobs.invalid_envelope`; an
 *   undeclared queue rejects with `jobs.unknown_queue`.
 * - When a child settles with a final outcome, the transport records the
 *   first final outcome per index in the same operation as the settle:
 *   completed or discarded as `completed`, skipped as `skipped`, a final
 *   failure as `failed` with its summary and the envelope's name. A dropped
 *   child is recorded too; a later settle of a recorded index is ignored.
 *   Once the recorded count reaches the total, `settled` becomes true and
 *   the finalizer becomes runnable, exactly once.
 * - `FailedJobsCapability.retry` of a failed child of an unsettled batch
 *   clears that index; after settlement it increments
 *   `retriedAfterSettlement` and changes no count.
 * - The status of a settled batch stays readable for at least 7 days.
 */
export interface FlowTransport {
  enqueueBatch(batch: BatchEnqueue): Promise<{ readonly deduplicated: boolean }>;
  batchStatus(id: string): Promise<BatchStatus | undefined>;
  /** Failed children by ascending index, at most `limit` (1 to 100). */
  childFailures(id: string, limit: number): Promise<readonly BatchChildFailure[]>;
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

/** A position in the failed-job list: the `failedAt` and `id` of its last entry. */
export interface FailedJobCursor {
  readonly failedAt: number;
  readonly id: string;
}

/**
 * Failed jobs live only in the transport. A job is failed when its last
 * attempt failed for good and the transport kept it; a drop or a retention
 * eviction means it is not.
 *
 * - `list` is newest first: `failedAt` descending, then `id` descending by
 *   UTF-16 code unit, so a cursor places itself even after its job is gone.
 *   `before` excludes the cursor position and everything newer. `limit` is 1
 *   to 1,000, default 50; an undeclared `queue` rejects with
 *   `jobs.unknown_queue`.
 * - `retry` is one atomic transport operation; the first matching rule wins:
 *   1. `not_found`: no retained job has the id;
 *   2. `not_failed`: the job is in any other state;
 *   3. `not_retryable`: the stored envelope does not decode as the current
 *      or a newer version, or `meta.flow` is a chain membership with
 *      `catchFired` and `force` is not set (`retryRefusal`);
 *   4. `retried`: the job leaves the failed set and waits under the same id
 *      with the same stored envelope; `attemptsMade` and `unknownReleases`
 *      reset to 0 and the failure record is cleared. The batch-child rule of
 *      {@link FlowTransport} applies.
 * - `remove` deletes a failed job only, and resolves whether it did.
 * - `prune` deletes failed jobs whose `failedAt` is older than
 *   `now - olderThanMs` (`olderThanMs` from 0 to one year) and resolves how
 *   many it deleted.
 */
export interface FailedJobsCapability {
  list(options?: {
    readonly queue?: string;
    readonly limit?: number;
    readonly before?: FailedJobCursor;
  }): Promise<readonly FailedJob[]>;
  get(id: string): Promise<FailedJob | undefined>;
  retry(id: string, options?: { readonly force?: boolean }): Promise<RetryResult>;
  remove(id: string): Promise<boolean>;
  prune(options: { readonly olderThanMs: number }): Promise<number>;
}

/** How a schedule repeats: an elapsed interval, or a cron pattern in a canonical IANA time zone. */
export type ScheduleRepeat =
  { readonly everyMs: number } | { readonly cron: string; readonly tz: string };

/** A schedule as reconcile hands it to the transport. */
export interface ScheduleSpec {
  /** Letters and digits in segments joined by `.`, `:`, `_` or `-`, at most 128 characters. */
  readonly id: string;
  /** A declared queue. */
  readonly queue: string;
  /** Enqueued at each fire time, with the fire's own key and dispatch time. */
  readonly envelope: JobEnvelope;
  readonly repeat: ScheduleRepeat;
}

/** A schedule as the transport stores it. */
export interface StoredSchedule extends ScheduleSpec {
  readonly paused: boolean;
  /** The next fire time, or undefined while paused. */
  readonly nextAt: number | undefined;
}

/** Who last reconciled a namespace's schedules. */
export interface ReconcileStamp {
  readonly app: string;
  readonly fingerprint: string;
  readonly appliedAt: number;
  readonly by: string;
}

/** The stored schedules of a namespace, read in one operation. */
export interface StoredScheduleSet {
  /** In id order. */
  readonly schedules: readonly StoredSchedule[];
  readonly stamp: ReconcileStamp | undefined;
  /** Changes with every applied {@link ScheduleChange}; a pause, a resume or a fire leaves it. */
  readonly revision: number;
}

/** One reconcile's change to the stored set. */
export interface ScheduleChange {
  /** New and changed schedules, each id once. */
  readonly upsert: readonly ScheduleSpec[];
  /** Ids to delete, none of them in `upsert`; unknown ids are ignored. */
  readonly remove: readonly string[];
  readonly stamp: ReconcileStamp;
}

/**
 * Schedules, reconciled as a whole; pause state lives only in the stored
 * record.
 *
 * - `apply` is one compare-and-set operation: when the set's revision is
 *   still `expectedRevision`, it stores each upsert, deletes each removed id,
 *   writes the stamp and changes the revision, then resolves true; otherwise
 *   it changes nothing and resolves false, so a reconcile that read a set
 *   another reconcile changed since reads it again rather than overwrite it.
 *   A new id starts unpaused, anchored at the time it is stored. An existing
 *   id keeps `paused`, and keeps its anchor and its last fire unless its
 *   repeat changed, which re-anchors it. A malformed change, or one that
 *   would hold more than `MAX_SCHEDULES`, rejects with
 *   `jobs.invalid_schedule`; an undeclared queue rejects with
 *   `jobs.unknown_queue`, both before anything is written.
 * - `setPaused` ignores unknown ids.
 * - Fire times: `everyMs` fires at `anchor + k * everyMs` for k >= 1; `cron`
 *   fires at its occurrences strictly after the anchor, in its time zone.
 *   Fire times missed while nothing fired are coalesced into one fire, keyed
 *   by the first missed time, when firing resumes; resuming a paused schedule
 *   skips every fire time up to the resume.
 * - The transport fires each unpaused schedule at its fire times, enqueueing
 *   the stored envelope with `meta.dispatchedAt` = the time it fired,
 *   `meta.key` = `jsails:schedule:<id>:<fire time>` and `meta.keyWindowMs` =
 *   `FLOW_KEY_WINDOW_MS`, so two firing components racing for one fire
 *   enqueue it once. A transport may fire through `startScheduleTicker`.
 */
export interface ScheduleCapability {
  read(): Promise<StoredScheduleSet>;
  apply(change: ScheduleChange, expectedRevision: number): Promise<boolean>;
  setPaused(ids: readonly string[], paused: boolean): Promise<void>;
}

/**
 * Owner-token leases for overlap control.
 *
 * - `acquire` resolves a fresh, unguessable, never-reused token when the key
 *   is free or its holder's lease expired, and `undefined` otherwise.
 * - `renew` and `release` are compare-and-set on the token: both resolve
 *   false for an expired or foreign token and never touch another holder's
 *   lease.
 * - Keys are 1 to 520 characters and live under the adapter's namespace;
 *   `ttlMs` is 1,000 to 3,600,000. Input out of bounds rejects with
 *   `jobs.invalid_option` naming `key`, `ttlMs` or `token`.
 */
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
   *
   * Chain advances, chain catches and batch callbacks are stored the same
   * way, as the follow-ups of the outcome that settles their step or
   * finalizer (see {@link ProcessJob}); their key window is what makes each
   * of them once-only when a step or a finalizer is redelivered.
   */
  enqueue(queue: string, envelope: JobEnvelope): Promise<JobHandle>;
  startWorker(options: WorkerOptions, process: ProcessJob): Promise<AdapterWorker>;
  /**
   * Stop every worker as `abort()` does and resolve once they have stopped. A
   * host whose runtime still holds attempts (`RuntimeWorker.held`) exits
   * instead of awaiting it.
   */
  close(): Promise<void>;
}
