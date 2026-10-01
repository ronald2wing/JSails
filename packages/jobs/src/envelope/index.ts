/**
 * The job envelope at runtime: the plain-JSON rule, the bounds of every job
 * option, and the builder and versioned decoder of the wire format the
 * contract declares.
 */

export {
  buildEnvelope,
  decodeEnvelope,
  decodeFlowStep,
  encodedSize,
  type DecodedEnvelope,
  type EnvelopeParts,
} from './codec.js';
export {
  backoffDelay,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_KEY_WINDOW_MS,
  DEFAULT_OVERLAP_TTL_MS,
  isJobName,
  JOB_OPTION_KEYS,
  MAX_ATTEMPTS,
  MAX_JOB_DELAY_MS,
  MAX_JOB_NAME_LENGTH,
  MAX_KEY_LENGTH,
  MAX_OVERLAP_TTL_MS,
  MAX_PRIORITY,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  MIN_OVERLAP_TTL_MS,
  validAttempts,
  validBackoff,
  validDelay,
  validDuration,
  validJobOptions,
  validKey,
  validOverlapTtl,
  validPriority,
  validTags,
  type JobOptionsProblem,
} from './job-options.js';
export { isPlainJson, MAX_JSON_DEPTH } from './plain-json.js';
