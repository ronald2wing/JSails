/**
 * Job definitions: typed, schema-validated handler pairs.
 */

export {
  createJobRegistry,
  defineJob,
  MAX_JOB_TIMEOUT_MS,
  JobPayloadError,
  JobNotRegisteredError,
  validatePayload,
  type JobContext,
  type JobDefinition,
  type JobClass,
  type JobInstance,
  type JobObjectDefinition,
  type JobHandler,
  type JobErrorPolicy,
  type JobErrorPredicate,
  type DefineJobOptions,
  type JobRegistry,
} from './registry.js';

// Command jobs: wrap a CLI command as a schedulable job.
export {
  CommandJobError,
  defineCommandJob,
  type CommandJobErrorCode,
  type CommandJobOptions,
} from './command-job.js';

// Class-based jobs: ApplicationJob + context tools.
export { ApplicationJob, JobContextError } from './application-job.js';
// Job discovery: autoload compiled `*.job.js` modules.
export { JobDiscoveryError, loadJobRegistryFromDirectory } from './discovery.js';

// Per-job middleware: cross-cutting worker-side behavior (logging, metrics,
// batching, chaining).
export {
  composeMiddleware,
  JobMiddlewareError,
  type JobMiddleware,
  type JobMiddlewareContext,
} from './middleware.js';

// Queue: bounded options and validation.
export {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  DEFAULT_REMOVE_ON_COMPLETE,
  DEFAULT_REMOVE_ON_FAIL,
  JobOptionsError,
  MAX_ATTEMPTS,
  MAX_STACK_TRACE_LIMIT,
  validateJobOptions,
  validateJobRetention,
  type JobQueue,
  type JobRetention,
  type JobRetentionOptions,
} from './queue.js';

// Scheduler: at-least-once cron/interval definitions and overlap control.
export {
  DEFAULT_OVERLAP_TTL_MS,
  DEFAULT_TIMEZONE,
  MAX_OVERLAP_TTL_MS,
  MAX_SCHEDULES,
  MIN_INTERVAL_MS,
  isOverlapDescriptor,
  ScheduleError,
  type JobWorker,
  type OverlapDescriptor,
  type OverlapPolicy,
  type PreparedSchedule,
  type ScheduleDefinition,
  type ScheduleRepeat,
  type WorkerJob,
} from './scheduler.js';

// Connection-URL validation shared by the config loader and the BullMQ adapter.
export { assertConnectionUrl, type ConnectionUrlErrorFactory } from '../valkey/connection.js';

// Runtime config: load, validate, and resolve the work/schedule config module.
export {
  DEFAULT_RUNTIME_CONFIG_PATH,
  DEFAULT_SCHEDULES_PATH,
  RuntimeConfigError,
  assertRedisUrl,
  loadResolvedRuntimeConfig,
  loadRuntimeConfigModule,
  resolveRuntimeValkeyUrl,
  validateRuntimeConfig,
  type ResolvedRuntimeConfig,
  type RuntimeConfig,
} from './runtime-config.js';

// Provider-neutral runtime: bind the registry to an adapter.
export {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  JobsRuntimeImpl,
  JobTimeoutError,
  UnrecoverableJobError,
  isJobAttemptInterrupted,
  isJobErrorNonRetryable,
  markJobErrorNonRetryable,
  validateJobsRuntimeAdapter,
  JobsRuntimeError,
  JobsRuntimeClosedError,
  type JobFailureInfo,
  type UpsertSchedulesOptions,
  type JobsRuntimeOptions,
  type JobAdapterContext,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type JobsRuntime,
  type ProcessJob,
  type QueueCounts,
  type RuntimeJob,
  type RuntimeProducer,
  type RuntimeWorker,
  type ScheduleInfo,
} from './runtime.js';

// Awaitable lives in shared internals; re-export it here so the public
// `jsails` and `jsails/jobs` barrels still resolve it at the same name.
export { type Awaitable } from '../contracts/awaitable.js';

// Built-in BullMQ adapter: the default transport for the neutral runtime.
export { BullMQAdapter, type BullMQAdapterOptions } from './bullmq-adapter.js';

// In-process adapter for development, tests, and single-process tools.
export { MemoryJobsAdapter } from './memory-adapter.js';

// Test double: a JobsService that records dispatches and asserts over them.
export {
  createFakeJobs,
  type FakeDispatch,
  type FakeJobs,
  type FakeJobsOptions,
} from './fake-jobs.js';

// First-party `jobs` plugin: a producer-only, lazily-built dispatch surface.
export { jobsPlugin, jobsToken, type JobsPluginOptions, type JobsService } from './plugin.js';

// The dashboard source contract: metrics, the failed-job store, and optional
// queue counts. One source feeds both the plugin (`jobsPlugin({ dashboard })`,
// validated at boot) and the read-only dashboard `@jsails/admin` renders from
// it (`jobsAdmin(source)`).
export {
  JobsDashboardError,
  validateJobsDashboardSource,
  type JobsDashboardSource,
} from './dashboard-source.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { jobsPlugin as default } from './plugin.js';

// In-memory job observers: per-job metrics aggregation and the bounded failed-job
// store with retry. These are pure in-process data structures with no external
// service dependency, suitable for diagnostics recorders and admin dashboards.
export {
  InMemoryJobMetrics,
  detectLongWaits,
  type JobMetrics,
  type JobMetricsSnapshot,
  type LongWaitThreshold,
} from './metrics.js';

export {
  JobMetricsHistoryImpl,
  type JobMetricsHistory,
  type JobMetricsHistoryEntry,
  type JobMetricsHistoryOptions,
} from './metrics-history.js';

// Job tags: caller-supplied monitoring labels carried in dispatch options and
// available as a filter on metrics/failed-store listing.
export {
  MAX_TAG_LENGTH,
  MAX_TAGS,
  normalizeTags,
  tagFilter,
  TAG_OPTION_KEY,
  TagError,
} from './tags.js';

// Job lifecycle events: value-free observability through the shared signals bus.
export {
  jobPushed,
  jobCompleted,
  jobFailed,
  jobRetried,
  MAX_JOB_ERROR_MESSAGE,
  summarizeJobError,
  type JobErrorSummary,
  type JobEventPayload,
} from './events.js';

export {
  InMemoryFailedJobStore,
  FailedJobNotFoundError,
  type FailedJobEntry,
  type FailedJobStore,
  type FailedJobStoreOptions,
} from './failed-jobs.js';

// Failed-job history: where the runtime records a job that failed for the last
// time, read by `jsails queue:failed` / `queue:retry` / `queue:forget`. The
// database history needs `failedJobEntities` in the app's data source.
export {
  DEFAULT_FAILED_JOB_HISTORY_ENTRIES,
  DEFAULT_FAILED_JOB_LIST_LIMIT,
  FailedJobHistoryError,
  InMemoryFailedJobHistory,
  MAX_FAILED_JOB_LIST_LIMIT,
  isFailedJobHistory,
  retryFailedJob,
  type FailedJobClearOptions,
  type FailedJobHistory,
  type FailedJobHistoryErrorCode,
  type FailedJobListOptions,
  type FailedJobRecordInput,
  type FailedJobRetryResult,
  type InMemoryFailedJobHistoryOptions,
} from './failed-job-history.js';
export {
  createDatabaseFailedJobHistory,
  type DatabaseFailedJobHistoryOptions,
} from './database-failed-job-history.js';
export { FAILED_JOB_TABLE, JsailsFailedJob, failedJobEntities } from './failed-job-entity.js';

// Job chaining: sequential, on-success continuation via per-job middleware.
export {
  chainMiddleware,
  CHAIN_OPTION_KEY,
  createJobChain,
  JobChainError,
  type ChainStep,
  type JobChain,
} from './chain.js';

// Job batching: fan-out with in-process settlement observation via per-job middleware.
export {
  DEFAULT_BATCH_TTL_MS,
  InMemoryBatchCoordinator,
  createBatchMiddleware,
  createJobBatch,
  isBatchDescriptor,
  BATCH_OPTION_KEY,
  JobBatchError,
  type BatchCallbacks,
  type BatchCoordinator,
  type BatchFailedSummary,
  type BatchFailure,
  type BatchItem,
  type BatchSummary,
  type JobBatch,
} from './batch.js';

// Shared-store batch coordinator: a `BatchCoordinator` backed by the `CacheStore`
// contract so producer and worker processes share batch progress (multi-process).
export { SharedBatchCoordinator, SharedBatchCoordinatorError } from './shared-batch-coordinator.js';

// Durable schedule pause: an opt-in `PausedScheduleStore` (memory or cache-backed)
// so a paused schedule stays paused across a `work` restart.
export {
  InMemoryPausedScheduleStore,
  CachePausedScheduleStore,
  PausedScheduleError,
  type PausedScheduleStore,
  type CachePausedScheduleStoreOptions,
} from './paused-schedules.js';

// Overlap control: mutex-backed middleware preventing concurrent scheduled runs.
export { createOverlapMiddleware, OVERLAP_OPTION_KEY } from './overlap.js';
