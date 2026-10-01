/**
 * Background jobs for JSails (`@jsails/jobs`).
 *
 * - Definitions: `defineJob` declares a job by name, Zod schema and handler;
 *   `Job.with(payload)` is an inert typed call that a `Jobs` service
 *   dispatches. `defineCommandJob` runs a CLI command as a job.
 * - Queues: `defineQueues` declares each queue's concurrency and retention
 *   (`default` is always present); `createJobCatalog` checks definitions
 *   against them; `jobsNamespace` names an app environment on a transport.
 * - The envelope: the framework-owned, versioned wire format a transport
 *   stores ({@link JOB_ENVELOPE_VERSION}), with its builder and decoder.
 * - Transports: the neutral {@link JobsAdapter} contract with its
 *   capabilities, and `memoryJobs`, the in-process transport.
 * - Time: `setLongTimeout`/`setLongInterval` hold delays longer than a Node
 *   timer can, on a replaceable {@link JobsClock}.
 *
 * The `@jsails/jobs/testing` subpath holds the adapter conformance suite. The
 * worker runtime and the plugin arrive in later work packages; until then
 * `jsails/jobs` is the running implementation behind `jsails work`.
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
  type JobHandle,
  type JobOptions,
  type JobOverlap,
} from './contract/envelope.js';
export { type AttemptOutcome, type JobErrorSummary } from './contract/outcome.js';
export {
  type AdapterWorker,
  type BatchStatus,
  type FailedJob,
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
  type SettleEvent,
  type StoredSchedule,
  type TransportJob,
  type WorkerOptions,
} from './contract/adapter.js';
export {
  CommandJobError,
  commandJobPayload,
  createJobCatalog,
  createProducer,
  defineCommandJob,
  defineJob,
  isJobDefinition,
  JobDefinitionError,
  JobDispatchError,
  type CommandJobErrorCode,
  type CommandJobOptions,
  type CommandJobRunContext,
  type CommandJobTarget,
  type JobCall,
  type JobCatalog,
  type JobContext,
  type JobDefinition,
  type JobDefinitionErrorCode,
  type JobDefinitionInput,
  type JobDispatchErrorCode,
  type JobErrorHandler,
  type JobHandler,
  type JobMiddleware,
  type JobProducer,
  type Jobs,
  type ProducerOptions,
} from './definition/index.js';
export {
  buildEnvelope,
  decodeEnvelope,
  JobEnvelopeError,
  MAX_ATTEMPTS,
  MAX_JOB_DELAY_MS,
  type DecodedEnvelope,
  type EnvelopeParts,
  type JobEnvelopeErrorCode,
} from './envelope/index.js';
export {
  DEFAULT_QUEUE,
  defineQueues,
  jobsNamespace,
  QueueConfigError,
  type Duration,
  type QueueConfigErrorCode,
  type QueueOptions,
  type QueueSet,
  type RetentionOptions,
} from './queues/index.js';
export {
  memoryJobs,
  MemoryJobsAdapter,
  MemoryJobsError,
  type MemoryJobsErrorCode,
  type MemoryJobsOptions,
  type MemoryQueueCounts,
} from './memory/index.js';
export {
  LongTimerError,
  setLongInterval,
  setLongTimeout,
  systemClock,
  type ClockTimer,
  type JobsClock,
  type LongTimer,
} from './timing/index.js';
