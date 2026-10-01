/**
 * The worker runtime: `startRuntimeWorker` runs the package's total processor
 * over any jobs adapter, with bounded drain and abort, the grace and
 * poisoned-worker rule, version-skew releases, execution-context restore,
 * value-free failure summaries, and the four job signals.
 *
 * The processor and the attempt are exported here for the package's own
 * tests and adapters and are deliberately absent from the package barrel.
 */

export { Attempt, type AbortCause, type AttemptLedger, type Settled } from './attempt.js';
export {
  emitSettleSignal,
  escalate,
  jobCompleted,
  jobFailed,
  jobReleased,
  jobSkipped,
  type JobCompletedSignal,
  type JobFailedSignal,
  type JobReleasedSignal,
  type JobSignalBase,
  type JobSkippedSignal,
} from './job-signals.js';
export {
  exitPoisonedProcess,
  POISONED_EXIT_BACKSTOP_MS,
  POISONED_EXIT_CODE,
} from './poisoned-exit.js';
export {
  createProcessor,
  MAX_UNKNOWN_RELEASES,
  UNKNOWN_RELEASE_BASE_MS,
  UNKNOWN_RELEASE_MAX_MS,
  unknownReleaseDelay,
  type ProcessorOptions,
} from './processor.js';
export {
  DEFAULT_ABORT_COLLECT_MS,
  DEFAULT_HANDLER_GRACE_MS,
  MAX_ABORT_COLLECT_MS,
  startRuntimeWorker,
  type DrainOptions,
  type PoisonedWorkerReport,
  type RuntimeWorker,
  type RuntimeWorkerOptions,
  type RuntimeWorkerState,
} from './runtime-worker.js';
