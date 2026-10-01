/**
 * The errors of job definitions and dispatch. Both are value-free: a message
 * names the rule that was broken and, at most, the framework's own option
 * name, never a payload, a key, or a job name a caller supplied.
 */

import { JsailsError } from 'jsails/support';

/**
 * What a definition or dispatch error may carry: the error it wraps, and as
 * context only names declared in code (a job or queue name of a definition),
 * never a value that arrived at runtime.
 */
export interface JobErrorOptions {
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, string>>;
}

export type JobDefinitionErrorCode =
  'invalid_definition' | 'unknown_option' | 'invalid_option' | 'duplicate_job' | 'unknown_queue';

/** Raised by `defineJob`, `defineCommandJob` and `createJobCatalog`. */
export class JobDefinitionError extends JsailsError {
  constructor(
    readonly code: JobDefinitionErrorCode,
    message: string,
    options?: JobErrorOptions,
  ) {
    super(message, options);
  }
}

export type JobDispatchErrorCode =
  | 'unknown_job'
  | 'unknown_option'
  | 'invalid_option'
  | 'invalid_payload'
  | 'payload_not_json'
  | 'context_not_json'
  | 'producer_closed';

/** Raised by a dispatch that enqueued nothing. */
export class JobDispatchError extends JsailsError {
  constructor(
    readonly code: JobDispatchErrorCode,
    message: string,
    options?: JobErrorOptions,
  ) {
    super(message, options);
  }
}
