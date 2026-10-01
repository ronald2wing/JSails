/**
 * The plugin state stores' error type, shared by the JSON file store and the
 * database-backed store, and apart from both so a caller that only reports a
 * state failure (the `plugins` command's error formatting) loads neither Zod
 * nor TypeORM. Messages and codes are value-free.
 */

import { JsailsError } from '../errors/jsails-error.js';

/** Stable failure code carried by {@link PluginStateError}. */
export type PluginStateErrorCode =
  | 'io_failed'
  | 'unparseable'
  | 'invalid_state'
  | 'invalid_plugin_id'
  | 'invalid_version'
  | 'too_many_plugins'
  | 'unavailable'
  | 'missing_table';

/** Raised for a missing/unreadable/malformed state file or an invalid write. */
export class PluginStateError extends JsailsError {
  constructor(
    readonly code: PluginStateErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}
