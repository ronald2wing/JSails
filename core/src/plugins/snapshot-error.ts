/**
 * The plugin snapshot's error type, apart from the Zod-validated snapshot
 * format so a caller that only reports snapshot failures (the `plugins`
 * command's error formatting) does not load Zod. Messages and codes are
 * value-free.
 */

import { JsailsError } from '../errors/jsails-error.js';

/** Stable failure code carried by {@link PluginSnapshotError}. */
export type PluginSnapshotErrorCode =
  | 'invalid_snapshot'
  | 'invalid_version'
  | 'duplicate_plugin_id'
  | 'too_many_plugins'
  | 'unparseable'
  | 'invalid_path'
  | 'io_failed';

/** Raised for a malformed snapshot or an import refusing every entry. */
export class PluginSnapshotError extends JsailsError {
  constructor(
    readonly code: PluginSnapshotErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}
