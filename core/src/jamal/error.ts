/**
 * The Jamal error classes: one `JamalError` for invocation and planning
 * failures, and `JamalConfigError` for an invalid `jamal.config.js`. Messages
 * never embed config values or secrets.
 */

import { JsailsError } from '../errors/jsails-error.js';

export type JamalErrorCode =
  | 'invalid_config'
  | 'missing_registry'
  | 'generator_collision'
  | 'target_outside_cwd'
  | 'output_collision';

/** Raised for an invalid invocation, plan, or registry operation. */
export class JamalError extends JsailsError {
  constructor(
    readonly code: JamalErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Raised for any missing or invalid jamal config. */
export class JamalConfigError extends JamalError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('invalid_config', message, options);
  }
}
