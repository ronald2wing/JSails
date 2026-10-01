/**
 * Content-layer error.
 *
 * Value-free: a `ContentError` never echoes a field value, frontmatter body, or
 * rendered HTML. The `message` may carry a source location (file path or slug)
 * because that is metadata needed to find the offending entry, not user input.
 */

import { JsailsError } from 'jsails/support';
import type { FieldError } from 'jsails/validation';

/** Machine-readable reason for a {@link ContentError}. */
export type ContentErrorCode =
  | 'missing_required_field'
  | 'invalid_frontmatter'
  | 'symlink_rejected'
  | 'invalid_collection'
  | 'invalid_field'
  | 'invalid_route'
  | 'invalid_order'
  | 'invalid_taxonomy'
  | 'duplicate_taxonomy'
  | 'invalid_site_url'
  | 'versions_unreadable'
  | 'versions_invalid_json'
  | 'versions_invalid_manifest'
  | 'versions_invalid_current'
  | 'versions_invalid_versions'
  | 'versions_invalid_entry'
  | 'versions_invalid_name'
  | 'versions_invalid_path'
  | 'versions_invalid_tag'
  | 'versions_invalid_banner'
  | 'versions_invalid_flag'
  | 'versions_unknown_reference'
  | 'versions_duplicate_name'
  | 'versions_unknown_version'
  | 'versions_invalid_prefix';

/** Raised for a malformed content entry or an invalid collection definition. */
export class ContentError extends JsailsError {
  /**
   * Field-level validation errors, present only when thrown by frontmatter
   * schema validation. Each entry is the same value-free `{ field, message }`
   * shape as `jsails/validation`; paths are dotted and messages are the
   * value-free schema-derived descriptions of `mapZodIssues`.
   */
  readonly errors: readonly FieldError[];

  constructor(
    readonly code: ContentErrorCode,
    message: string,
    errors: readonly FieldError[] = [],
  ) {
    super(message);
    this.errors = Object.freeze(errors);
  }
}
