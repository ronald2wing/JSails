/**
 * The installer's one error type, shared by the bundle intake, the installed
 * bundle index, and the installer itself. Messages and codes are value-free.
 */

import { JsailsError } from '../errors/jsails-error.js';

/** Stable machine code carried by every {@link PluginInstallerError}. */
export type PluginInstallerErrorCode =
  | 'invalid_options'
  | 'invalid_id'
  | 'invalid_version'
  | 'invalid_url'
  | 'fetch_failed'
  | 'oversize_download'
  | 'checksum_mismatch'
  | 'signature_invalid'
  | 'extract_failed'
  | 'manifest_missing'
  | 'manifest_ambiguous'
  | 'manifest_invalid'
  | 'manifest_mismatch'
  | 'install_failed'
  | 'state_failed'
  | 'unsatisfied_dependency'
  | 'required_by'
  | 'unknown_plugin'
  | 'unknown_version'
  | 'unsafe_uninstall';

/** Raised for any installer failure; messages and codes are value-free. */
export class PluginInstallerError extends JsailsError {
  constructor(
    readonly code: PluginInstallerErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}
