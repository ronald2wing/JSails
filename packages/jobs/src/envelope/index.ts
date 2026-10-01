/**
 * The job envelope at runtime: the plain-JSON rule, the bounds of every job
 * option, and the builder and versioned decoder of the wire format the
 * contract declares.
 */

export {
  buildEnvelope,
  decodeEnvelope,
  JobEnvelopeError,
  type DecodedEnvelope,
  type EnvelopeParts,
  type JobEnvelopeErrorCode,
} from './codec.js';
export {
  backoffDelay,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_KEY_WINDOW_MS,
  JOB_OPTION_KEYS,
  MAX_ATTEMPTS,
  MAX_JOB_DELAY_MS,
  MAX_KEY_LENGTH,
  MAX_PRIORITY,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  validAttempts,
  validBackoff,
  validDelay,
  validDuration,
  validJobOptions,
  validKey,
  validPriority,
  validTags,
  type JobOptionsProblem,
} from './job-options.js';
export { isPlainJson, MAX_JSON_DEPTH } from './plain-json.js';
