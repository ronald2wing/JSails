/**
 * The application config's value-free error, {@link AppConfigError}.
 *
 * Apart from the Zod schema so the CLI dispatcher can recognise a config
 * failure without loading Zod: a command that never loads a config never
 * pays for its validator.
 */

import { JsailsError } from '../../errors/jsails-error.js';

/** A single value-free config field error. */
export interface ConfigSchemaIssue {
  /** Location of the failure, e.g. `["port"]`. Never a raw value. */
  readonly path: readonly (string | number)[];
  /** Stable machine code, e.g. `"invalid_type"`, `"unrecognized_keys"`. */
  readonly code: string;
  /** Short description derived only from the schema, never from input. */
  readonly message: string;
}

/** Stable failure code carried by {@link AppConfigError}. */
export type AppConfigErrorCode =
  'invalid_config' | 'unsupported_config' | 'load_failed' | 'missing_service';

/** Options accepted by the {@link AppConfigError} constructor. */
export interface AppConfigErrorOptions {
  /** Failure code; defaults to `invalid_config`. */
  readonly code?: AppConfigErrorCode;
  /** Structured, value-free failures from schema validation. */
  readonly issues?: readonly ConfigSchemaIssue[];
  readonly cause?: unknown;
}

/** Raised for any invalid application config. Messages never embed input. */
export class AppConfigError extends JsailsError {
  readonly code: AppConfigErrorCode;
  /** Structured, value-free failures. Set only when the error originates from Zod validation. */
  readonly issues: readonly ConfigSchemaIssue[] | undefined;

  constructor(message: string, options?: AppConfigErrorOptions) {
    super(message, options);
    this.code = options?.code ?? 'invalid_config';
    this.issues = options?.issues;
  }
}

/** True when `error` is an application-config error. */
export function isAppConfigError(error: unknown): error is AppConfigError {
  return error instanceof AppConfigError;
}
