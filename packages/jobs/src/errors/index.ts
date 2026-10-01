/**
 * The package's errors: the `jobs.*` registry every failure is raised
 * through, and the value-free `JobErrorSummary` producer the runtime
 * and the adapters store failures with.
 *
 * The summary producer and its checks are exported here for the package's own
 * runtime and adapters and are deliberately absent from the package barrel.
 */

export {
  isJobErrorSummary,
  isSummaryCode,
  isSummaryName,
  MAX_SUMMARY_CODE_LENGTH,
  MAX_SUMMARY_FRAME_LENGTH,
  MAX_SUMMARY_FRAMES,
  MAX_SUMMARY_MESSAGE_LENGTH,
  MAX_SUMMARY_NAME_LENGTH,
  MAX_SUMMARY_STACK_LENGTH,
  runtimeSummary,
  summarizeJobError,
  type SummarizedError,
  type SummaryOptions,
} from './error-summary.js';
export { JobsErrors, type JobsErrorCode } from './jobs-errors.js';
