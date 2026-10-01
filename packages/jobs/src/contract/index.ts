/**
 * The neutral jobs contract: the envelope wire format, attempt outcomes, and
 * the transport adapter with its capabilities. Types and one wire constant
 * only; nothing here runs.
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
} from './envelope.js';
export { type AttemptOutcome, type JobErrorSummary } from './outcome.js';
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
} from './adapter.js';
