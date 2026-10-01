/**
 * The relation layer's error. Its own module because the metadata lookups, the
 * relation resolver, and the through-relation detector all raise it, and the
 * resolver imports the other two.
 */

import { JsailsError } from '../errors/jsails-error.js';

/** Machine-readable reason for a {@link RelationError}. */
export type RelationErrorCode =
  'unsupported_relation' | 'missing_relation' | 'invalid_relation' | 'invalid_relation_path';

/** Raised for relation-resolution failures. Value-free. */
export class RelationError extends JsailsError {
  constructor(
    readonly code: RelationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
