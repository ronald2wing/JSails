/**
 * Background jobs for JSails (`@jsails/jobs`).
 *
 * - Definitions: `defineJob` declares a job by name, Zod schema and handler;
 *   `Job.with(payload)` is an inert typed call that a `Jobs` service
 *   dispatches. `defineCommandJob` runs a `defineCommand` command as a job.
 * - Queues: `defineQueues` declares each queue's concurrency and retention
 *   (`default` is always present); `createJobCatalog` checks definitions
 *   against them; `jobsNamespace` names an app environment on a transport.
 * - The envelope: the framework-owned, versioned wire format a transport
 *   stores ({@link JOB_ENVELOPE_VERSION}), with its builder and decoder.
 * - Transports: the neutral {@link JobsAdapter} contract with its
 *   capabilities, and `memoryJobs`, the in-process transport.
 * - The worker runtime: `startRuntimeWorker` runs a total processor over any
 *   adapter (attempt outcomes, bounded drain and abort, the grace and
 *   poisoned-worker rule, version-skew releases, execution-context restore,
 *   value-free failure summaries) and emits the four job signals.
 * - Flows: `Jobs.chain` runs steps in order, advanced by the worker with
 *   keyed enqueues so a redelivery never forks a chain (an optional catch
 *   fires once); `Jobs.batch` runs items in parallel on the adapter's flows
 *   capability, with a built-in finalizer firing then or catch, then
 *   finally, each once.
 * - Failed jobs: kept only by the transport, listed, retried under the same
 *   id with the same envelope in one atomic operation, removed, or pruned.
 * - Overlap: a definition's `overlap` holds a lease for the run; a held key
 *   makes the attempt a `skipped` outcome, which never advances a chain.
 * - Schedules: `schedule()` declares one (an interval, or a cron pattern in
 *   an IANA time zone); `reconcileSchedules()` makes the declared set the
 *   stored set and keeps pause state; `pauseSchedules`/`resumeSchedules`.
 * - Errors: every failure is a `jobs.*` code of {@link JobsErrors}.
 * - Time: `setLongTimeout`/`setLongInterval` hold delays longer than a Node
 *   timer can, on a replaceable {@link JobsClock}.
 *
 * The `@jsails/jobs/testing` subpath holds the adapter conformance suite, and
 * `@jsails/jobs/valkey` the shared transport on BullMQ (an optional peer).
 * The plugin arrives with JOB-06; until then `jsails work` runs `jsails/jobs`.
 *
 * Importing this barrel is inert: nothing runs and no timer starts.
 */

export {
  JOB_ENVELOPE_VERSION,
  type DispatchOptions,
  type JobBackoff,
  type JobEnvelope,
  type JobEnvelopeMeta,
  type JobFlowMembership,
  type JobFlowStep,
  type JobHandle,
  type JobOptions,
  type JobOverlap,
} from './contract/envelope.js';
export { type AttemptOutcome, type JobErrorSummary, type JobFollowUp } from './contract/outcome.js';
export { type JobsCapabilityName } from './contract/capabilities.js';
export {
  type AdapterWorker,
  type BatchChildFailure,
  type BatchEnqueue,
  type BatchStatus,
  type FailedJob,
  type FailedJobCursor,
  type FailedJobRef,
  type FailedJobsCapability,
  type FlowTransport,
  type JobsAdapter,
  type JobsAdapterCapabilities,
  type JobsAdapterContext,
  type JobsAdapterFactory,
  type LeaseCapability,
  type ProcessJob,
  type QueueDeclaration,
  type ReconcileStamp,
  type RetentionRule,
  type RetryResult,
  type ScheduleCapability,
  type ScheduleChange,
  type ScheduleRepeat,
  type ScheduleSpec,
  type SettleEvent,
  type StoredSchedule,
  type StoredScheduleSet,
  type TransportJob,
  type WorkerOptions,
} from './contract/adapter.js';
export {
  commandJobPayload,
  createJobCatalog,
  createProducer,
  defineCommandJob,
  defineJob,
  isJobDefinition,
  type BatchHandle,
  type BatchOptions,
  type ChainHandle,
  type ChainOptions,
  type CommandJobOptions,
  type CommandJobTarget,
  type JobActor,
  type JobCall,
  type JobCatalog,
  type JobContext,
  type JobDefinition,
  type JobDefinitionInput,
  type JobErrorHandler,
  type JobFlowPosition,
  type JobHandler,
  type JobMeta,
  type JobMiddleware,
  type JobProducer,
  type Jobs,
  type ProducerOptions,
} from './definition/index.js';
export {
  buildEnvelope,
  decodeEnvelope,
  MAX_ATTEMPTS,
  MAX_JOB_DELAY_MS,
  type DecodedEnvelope,
  type EnvelopeParts,
} from './envelope/index.js';
export { JobsErrors, type JobsErrorCode } from './errors/index.js';
export {
  BATCH_FINALIZER_JOB,
  MAX_BATCH_ITEMS,
  MAX_CHAIN_STEPS,
  MAX_CHUNKED_BATCH_ITEMS,
  MAX_FLOW_BYTES,
} from './flows/index.js';
export {
  MAX_SCHEDULES,
  pauseSchedules,
  reconcileSchedules,
  resumeSchedules,
  schedule,
  type ReconcileOptions,
  type ReconcileResult,
  type ScheduleDefinition,
  type ScheduleOptions,
} from './schedules/index.js';
export {
  DEFAULT_QUEUE,
  defineQueues,
  jobsNamespace,
  type Duration,
  type QueueOptions,
  type QueueSet,
  type RetentionOptions,
} from './queues/index.js';
export {
  memoryJobs,
  MemoryJobsAdapter,
  type MemoryJobsOptions,
  type MemoryQueueCounts,
} from './memory/index.js';
export {
  DEFAULT_ABORT_COLLECT_MS,
  DEFAULT_HANDLER_GRACE_MS,
  exitPoisonedProcess,
  jobCompleted,
  jobFailed,
  jobReleased,
  jobSkipped,
  POISONED_EXIT_CODE,
  startRuntimeWorker,
  type DrainOptions,
  type JobCompletedSignal,
  type JobFailedSignal,
  type JobReleasedSignal,
  type JobSignalBase,
  type JobSkippedSignal,
  type PoisonedWorkerReport,
  type RuntimeWorker,
  type RuntimeWorkerOptions,
  type RuntimeWorkerState,
} from './runtime/index.js';
export {
  setLongInterval,
  setLongTimeout,
  systemClock,
  type ClockTimer,
  type JobsClock,
  type LongTimer,
} from './timing/index.js';
