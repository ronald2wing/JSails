/**
 * The neutral jobs contract: the envelope wire format, attempt outcomes, and
 * the transport adapter with its capabilities, plus the rules every adapter
 * shares with the runtime: the outcome check on what a processor resolved
 * with, when a failure is final, and reading a capability.
 *
 * The outcome check, `isFinalFailure` and `requireCapability` are exported
 * here for the package's own runtime and adapters and are deliberately absent
 * from the package barrel.
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
} from './envelope.js';
export { type AttemptOutcome, type JobErrorSummary, type JobFollowUp } from './outcome.js';
export {
  checkedAttemptOutcome,
  MAX_FOLLOW_UPS,
  PROCESSOR_BROKE_CONTRACT,
} from './outcome-check.js';
export { isFinalFailure } from './final-failure.js';
export { requireCapability, type JobsCapabilityName } from './capabilities.js';
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
} from './adapter.js';
