/**
 * Producer queue surface and shared job-option policy.
 *
 * This module owns the pieces every BullMQ job path shares: the {@link JobQueue}
 * structural contract (a BullMQ `Queue` satisfies it), the bounded
 * dispatch-option allowlist (`validateJobOptions`), and the default job options
 * (`defaultJobOptions`). The built-in BullMQ adapter (`./bullmq-adapter.js`) and
 * the neutral runtime (`./runtime.js`) consume these; importing this module
 * opens no connection — only instantiating a queue/worker does.
 *
 * Bounded, safe defaults:
 * - Every dispatched job gets `attempts: 3` and exponential backoff (1000ms
 *   base) unless overridden.
 * - Finished jobs are trimmed: completed jobs are kept for an hour (at most
 *   1000), failed jobs for a week (at most 5000), so the queue's keys never
 *   grow without bound. Both are configurable per queue and per dispatch.
 * - Overridden job options are validated against an allowlist; `attempts` is
 *   capped so a caller cannot request unbounded retries.
 * - `jobId` is an optional idempotency hint, not an exactly-once guarantee:
 *   BullMQ skips adding a job whose id already exists, but redelivery after a
 *   worker crash is at-least-once.
 */

import type {
  BackoffOptions,
  ConnectionOptions,
  JobSchedulerJson,
  JobsOptions,
  JobSchedulerTemplateOptions,
  KeepJobs,
  JobType,
  QueueOptions,
  RepeatOptions,
} from 'bullmq';
import { JsailsError } from '../errors/jsails-error.js';
import {
  BATCH_OPTION_KEY,
  CHAIN_OPTION_KEY,
  OVERLAP_OPTION_KEY,
  TAG_OPTION_KEY,
} from './option-keys.js';

/** Default number of attempts for a dispatched job. */
export const DEFAULT_ATTEMPTS = 3;

/** Base delay (ms) for the default exponential backoff. */
export const DEFAULT_BACKOFF_MS = 1000;

/** Upper bound on overridden `attempts`; prevents unbounded retries. */
export const MAX_ATTEMPTS = 25;

/**
 * How long finished jobs are kept: `true` removes at once, `false` keeps
 * forever, a number keeps that many, and an object bounds by `count`, or by
 * `age` in seconds (optionally with `count` and a per-cleanup `limit`). The
 * BullMQ `removeOnComplete`/`removeOnFail` shape.
 */
export type JobRetention =
  | boolean
  | number
  | { readonly count: number }
  | { readonly age: number; readonly count?: number; readonly limit?: number };

/** Retention overrides for one queue; absent fields keep the defaults. */
export interface JobRetentionOptions {
  readonly removeOnComplete?: JobRetention;
  readonly removeOnFail?: JobRetention;
}

/** Default completed-job retention: one hour, at most 1000 jobs. */
export const DEFAULT_REMOVE_ON_COMPLETE: JobRetention = Object.freeze({ age: 3600, count: 1000 });

/** Default failed-job retention: seven days, at most 5000 jobs. */
export const DEFAULT_REMOVE_ON_FAIL: JobRetention = Object.freeze({ age: 7 * 86_400, count: 5000 });

/** Upper bound on `stackTraceLimit`; a stack is stored per failed attempt. */
export const MAX_STACK_TRACE_LIMIT = 50;

/** The underlying queue surface this library needs. A BullMQ `Queue` satisfies it. */
export interface JobQueue {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
  on(eventName: 'error', listener: (error: Error) => void): unknown;
  upsertJobScheduler(
    jobSchedulerId: string,
    repeatOpts: Omit<RepeatOptions, 'key'>,
    jobTemplate?: {
      name?: string;
      data?: unknown;
      opts?: JobSchedulerTemplateOptions;
    },
  ): Promise<unknown>;
  /**
   * Read per-type job counts for the requested states. Present on the built-in
   * BullMQ `Queue`; a mock/alternate queue may omit it (a capability, not a
   * requirement of the producer contract).
   */
  getJobCounts?(...types: JobType[]): Promise<{ [index: string]: number }>;
  /**
   * List registered job schedulers. Present on the built-in BullMQ `Queue`; a
   * mock/alternate queue may omit it (a capability, not a requirement).
   */
  getJobSchedulers?(): Promise<readonly JobSchedulerJson[]>;
  /**
   * Remove a job scheduler by id. Present on the built-in BullMQ `Queue`; a
   * mock/alternate queue may omit it (a capability, not a requirement).
   */
  removeJobScheduler?(jobSchedulerId: string): Promise<boolean>;
  /**
   * Pause the queue so no new jobs are processed. Non-durable and
   * process-scoped: the provider owns the pause state, and a restarted
   * process sees the provider's own default. Present on the built-in BullMQ
   * `Queue`; a mock/alternate queue may omit it (a capability, not a
   * requirement).
   */
  pause?(): Promise<void>;
  /**
   * Resume a paused queue so jobs are processed again. Non-durable and
   * process-scoped: the provider owns the resume state. Present on the
   * built-in BullMQ `Queue`; a mock/alternate queue may omit it (a
   * capability, not a requirement).
   */
  resume?(): Promise<void>;
}

/** Dependency-injection seam: builds the underlying queue. Tests pass a mock. */
export type QueueFactory = (name: string, opts: QueueOptions<ConnectionOptions>) => JobQueue;

/** Stable failure code carried by {@link JobOptionsError}. */
export type JobOptionsErrorCode = 'invalid_options' | 'unsupported_option' | 'invalid_option';

/** Raised when overridden job options are not in the allowlist or unbounded. */
export class JobOptionsError extends JsailsError {
  constructor(
    readonly code: JobOptionsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The only job-option keys a dispatch may override. Everything else is rejected. */
const ALLOWED_JOB_OPTIONS = new Set([
  'jobId',
  'delay',
  'priority',
  'lifo',
  'attempts',
  'backoff',
  'removeOnComplete',
  'removeOnFail',
  'keepLogs',
  'stackTraceLimit',
  'sizeLimit',
  // Framework-reserved key for job chaining. A caller who can dispatch can
  // already dispatch any registered job — the descriptor grants no new
  // capability. The descriptor is stored verbatim in dispatch options; the
  // chain middleware validates the descriptor structurally on the worker
  // side and fails safe (returns the handler result unchanged) on a
  // malformed descriptor. See src/jobs/chain.ts.
  CHAIN_OPTION_KEY,
  // Framework-reserved key for job batching. Same trust model as chaining:
  // the batch middleware validates the descriptor structurally on the
  // worker side and fails safe. See src/jobs/batch.ts.
  BATCH_OPTION_KEY,
  // Framework-reserved key for overlap control. Same trust model as
  // chaining/batching: the overlap middleware validates the descriptor
  // structurally on the worker side and fails safe. See src/jobs/overlap.ts.
  OVERLAP_OPTION_KEY,
  // Framework-reserved key for job tags. Same trust model as other
  // reserved keys: the value is forwarded verbatim so the worker-side
  // reader can normalize and attach it to metrics/failed-store entries.
  // See src/jobs/tags.ts.
  TAG_OPTION_KEY,
]);

/**
 * The default job options: bounded attempts with exponential backoff, and
 * bounded retention of finished jobs (overridable per queue).
 */
export function defaultJobOptions(retention: JobRetentionOptions = {}): JobsOptions {
  return {
    attempts: DEFAULT_ATTEMPTS,
    backoff: { type: 'exponential', delay: DEFAULT_BACKOFF_MS },
    removeOnComplete: toKeepJobs(retention.removeOnComplete ?? DEFAULT_REMOVE_ON_COMPLETE),
    removeOnFail: toKeepJobs(retention.removeOnFail ?? DEFAULT_REMOVE_ON_FAIL),
  };
}

/** A fresh mutable copy, so BullMQ never sees the frozen default objects. */
function toKeepJobs(value: JobRetention): boolean | number | KeepJobs {
  return typeof value === 'object' ? { ...value } : value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate a retention value (`removeOnComplete`/`removeOnFail`): a boolean, a
 * non-negative integer count, or `{ age?, count?, limit? }` of non-negative
 * integers. `label` names the option in the value-free error.
 */
export function validateJobRetention(value: unknown, label: string): JobRetention {
  if (typeof value === 'boolean' || isNonNegativeInteger(value)) {
    return value;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    const fields: { age?: number; count?: number; limit?: number } = {};
    for (const key of Object.keys(source)) {
      if (key !== 'age' && key !== 'count' && key !== 'limit') {
        throw new JobOptionsError('invalid_option', `${label} supports only age, count, and limit`);
      }
      const field = source[key];
      if (field === undefined) continue;
      if (!isNonNegativeInteger(field)) {
        throw new JobOptionsError(
          'invalid_option',
          `${label}.${key} must be a non-negative integer`,
        );
      }
      fields[key] = field;
    }
    const { age, count, limit } = fields;
    if (age !== undefined) {
      return {
        age,
        ...(count !== undefined ? { count } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
    }
    if (count !== undefined && limit === undefined) {
      return { count };
    }
    throw new JobOptionsError(
      'invalid_option',
      `${label} needs age or count (limit applies only with age)`,
    );
  }
  throw new JobOptionsError(
    'invalid_option',
    `${label} must be a boolean, a non-negative integer, or { age, count }`,
  );
}

/**
 * Validate overridden job options against the allowlist, bounding `attempts`
 * and `backoff` so a caller cannot request unbounded retries.
 */
export function validateJobOptions(opts: unknown): JobsOptions {
  if (opts === undefined) {
    return {};
  }
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new JobOptionsError('invalid_options', 'job options must be an object');
  }

  const source = opts as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!ALLOWED_JOB_OPTIONS.has(key)) {
      throw new JobOptionsError('unsupported_option', `unsupported job option "${key}"`);
    }
  }

  const result: JobsOptions = {};

  if (source.jobId !== undefined) {
    if (typeof source.jobId !== 'string' || source.jobId === '') {
      throw new JobOptionsError('invalid_option', 'jobId must be a non-empty string');
    }
    result.jobId = source.jobId;
  }
  if (source.delay !== undefined) {
    if (typeof source.delay !== 'number' || !Number.isFinite(source.delay) || source.delay < 0) {
      throw new JobOptionsError(
        'invalid_option',
        'delay must be a non-negative number of milliseconds',
      );
    }
    result.delay = source.delay;
  }
  if (source.priority !== undefined) {
    if (typeof source.priority !== 'number' || !Number.isInteger(source.priority)) {
      throw new JobOptionsError('invalid_option', 'priority must be an integer');
    }
    result.priority = source.priority;
  }
  if (source.lifo !== undefined) {
    if (typeof source.lifo !== 'boolean') {
      throw new JobOptionsError('invalid_option', 'lifo must be a boolean');
    }
    result.lifo = source.lifo;
  }
  if (source.attempts !== undefined) {
    if (
      typeof source.attempts !== 'number' ||
      !Number.isInteger(source.attempts) ||
      source.attempts < 1 ||
      source.attempts > MAX_ATTEMPTS
    ) {
      throw new JobOptionsError(
        'invalid_option',
        `attempts must be an integer between 1 and ${MAX_ATTEMPTS}`,
      );
    }
    result.attempts = source.attempts;
  }
  if (source.backoff !== undefined) {
    result.backoff = validateBackoff(source.backoff);
  }

  // Framework-reserved key for job chaining: passed through verbatim so the
  // chain middleware can read it from job.opts on the worker side. A caller
  // who can dispatch can already dispatch any registered job, so the
  // descriptor grants no new capability. The middleware validates the
  // descriptor structurally and fails safe on a malformed one.
  if (source.__jsailsChain !== undefined) {
    (result as Record<string, unknown>).__jsailsChain = source.__jsailsChain;
  }

  // Framework-reserved key for job batching: same trust model as chaining.
  // The batch middleware validates the descriptor structurally and fails safe.
  if (source.__jsailsBatch !== undefined) {
    (result as Record<string, unknown>).__jsailsBatch = source.__jsailsBatch;
  }

  // Framework-reserved key for overlap control: same trust model.
  // The overlap middleware validates the descriptor structurally and fails safe.
  if (source.__jsailsOverlap !== undefined) {
    (result as Record<string, unknown>).__jsailsOverlap = source.__jsailsOverlap;
  }

  // Framework-reserved key for job tags: same trust model as other reserved
  // keys. The value is forwarded verbatim; the worker-side reader normalizes
  // and attaches it to metrics and failed-job store entries.
  if (source.__jsailsTags !== undefined) {
    (result as Record<string, unknown>).__jsailsTags = source.__jsailsTags;
  }

  for (const key of ['removeOnComplete', 'removeOnFail'] as const) {
    const value = source[key];
    if (value !== undefined) {
      result[key] = toKeepJobs(validateJobRetention(value, key));
    }
  }
  if (source.keepLogs !== undefined) {
    if (!isNonNegativeInteger(source.keepLogs)) {
      throw new JobOptionsError('invalid_option', 'keepLogs must be a non-negative integer');
    }
    result.keepLogs = source.keepLogs;
  }
  if (source.stackTraceLimit !== undefined) {
    if (
      !isNonNegativeInteger(source.stackTraceLimit) ||
      source.stackTraceLimit > MAX_STACK_TRACE_LIMIT
    ) {
      throw new JobOptionsError(
        'invalid_option',
        `stackTraceLimit must be an integer between 0 and ${MAX_STACK_TRACE_LIMIT}`,
      );
    }
    result.stackTraceLimit = source.stackTraceLimit;
  }
  if (source.sizeLimit !== undefined) {
    if (!isNonNegativeInteger(source.sizeLimit) || source.sizeLimit === 0) {
      throw new JobOptionsError('invalid_option', 'sizeLimit must be a positive integer');
    }
    result.sizeLimit = source.sizeLimit;
  }

  return result;
}

function validateBackoff(value: unknown): number | BackoffOptions {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new JobOptionsError(
        'invalid_option',
        'backoff must be a non-negative number of milliseconds',
      );
    }
    return value;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const backoff = value as Record<string, unknown>;
    const type = backoff.type;
    if (type !== 'fixed' && type !== 'exponential') {
      throw new JobOptionsError('invalid_option', 'backoff.type must be "fixed" or "exponential"');
    }
    const delay = backoff.delay;
    if (
      delay !== undefined &&
      (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0)
    ) {
      throw new JobOptionsError(
        'invalid_option',
        'backoff.delay must be a non-negative number of milliseconds',
      );
    }
    return { type, delay };
  }
  throw new JobOptionsError(
    'invalid_option',
    'backoff must be a number or a { type, delay } object',
  );
}
