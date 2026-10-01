/**
 * The platform scope of jamal, stated in code: Windows is supported for
 * development, so the local verbs (`verb-scope.ts`) run there; every server
 * verb refuses with a value-free `unsupported_platform` error, because the
 * deploy path drives `ssh`, `sh -c`, and POSIX paths on the host.
 */

import { JsailsError } from 'jsails/errors';

import { isLocalVerb } from './verb-scope.js';

/** Raised when a jamal verb does not run on this platform. Value-free. */
export class UnsupportedPlatformError extends JsailsError {
  readonly code = 'unsupported_platform';
}

/**
 * Throws `unsupported_platform` when `verb` does not run on `platform`. A
 * missing verb (help or usage) is not refused.
 */
export function assertVerbSupported(
  verb: string | undefined,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32' || verb === undefined) return;
  if (isLocalVerb(verb)) return;
  throw new UnsupportedPlatformError('this jamal command does not run on Windows', {
    context: { platform },
    suggestion:
      'On Windows jamal runs the local services (up, down, logs, ps, exec); deploy from Linux or macOS',
  });
}
