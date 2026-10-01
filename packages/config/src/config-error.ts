/**
 * The value-free error every part of `@jsails/config` raises. A message states
 * the rule that failed and never a value; `set` and `key`, when present, are
 * names from the developer's own declarations or sync files, never request
 * input.
 */

import { JsailsError } from 'jsails/plugin-sdk';

/** Stable codes carried by a {@link ConfigError}. */
export type ConfigErrorCode =
  | 'invalid_set'
  | 'invalid_field'
  | 'duplicate_set'
  | 'unknown_set'
  | 'unknown_key'
  | 'invalid_value'
  | 'overridden'
  | 'invalid_snapshot'
  | 'invalid_options'
  | 'not_initialized'
  | 'missing_table';

/** A config failure with a stable code and a value-free message. */
export class ConfigError extends JsailsError {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
    readonly set?: string,
    readonly key?: string,
  ) {
    super(message);
  }
}
