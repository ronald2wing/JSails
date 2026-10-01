/**
 * The Jamal error classes: `JamalError` for invocation failures and
 * `JamalConfigError` for a missing or invalid jamal config. Messages never
 * embed config values or secrets.
 */

import { JsailsError } from 'jsails/support';

/**
 * Why a jamal invocation failed.
 *
 * @public
 */
export type JamalErrorCode = 'invalid_config';

/**
 * Options a jamal error carries: the wrapped failure and a static fix.
 *
 * @public
 */
export interface JamalErrorOptions {
  readonly cause?: unknown;
  /** The one-line fix to try next. Static text, never interpolated. */
  readonly suggestion?: string;
}

/**
 * Raised for an invalid invocation.
 *
 * @public
 */
export class JamalError extends JsailsError {
  constructor(
    readonly code: JamalErrorCode,
    message: string,
    options?: JamalErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Raised for any missing or invalid jamal config.
 *
 * @public
 */
export class JamalConfigError extends JamalError {
  constructor(message: string, options?: JamalErrorOptions) {
    super('invalid_config', message, options);
  }
}
