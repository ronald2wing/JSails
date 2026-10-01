/**
 * The value-free error a model resource raises for a definition it refuses, or
 * for a runtime rule a definition cannot check ahead of time.
 */

import { JsailsError } from 'jsails/plugin-sdk';

/** Stable codes carried by a {@link ModelResourceError}. */
export type ModelResourceErrorCode =
  | 'invalid_model'
  | 'invalid_name'
  | 'missing_authorize'
  | 'missing_scope'
  | 'invalid_scope'
  | 'invalid_fields'
  | 'invalid_field'
  | 'unknown_column'
  | 'missing_primary_key'
  | 'primary_key_writable'
  | 'writeonly_queryable'
  | 'encrypted_field'
  | 'encrypted_queryable'
  | 'json_queryable'
  | 'search_not_text'
  | 'invalid_sort'
  | 'stamped_field_writable'
  | 'invalid_stamp'
  | 'invalid_actions'
  | 'action_not_allowed';

/**
 * A model resource failure. The message states the rule that failed and never
 * a value. `field`, when present, names the declared field it concerns: a name
 * from the developer's own definition, never from a request.
 */
export class ModelResourceError extends JsailsError {
  constructor(
    readonly code: ModelResourceErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}
