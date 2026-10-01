/**
 * The platform scope of jamal, stated in code: Windows is supported for
 * development, so the verbs that drive the managed local Compose project run
 * there; every verb that reaches or plans for the server refuses with a
 * value-free `unsupported_platform` error, because the deploy path drives
 * `ssh`, `sh -c`, and POSIX paths on the host.
 */

import { JsailsError } from 'jsails/support';

/** Raised when a jamal verb does not run on this platform. Value-free. */
export class UnsupportedPlatformError extends JsailsError {
  readonly code = 'unsupported_platform';
}

/**
 * The verbs that run on Windows: the local services (`up`, `down`, `logs`,
 * `ps`, `exec`) and the shortcuts that run a command in the dev app container.
 */
const WINDOWS_VERBS: ReadonlySet<string> = new Set([
  'up',
  'down',
  'logs',
  'ps',
  'exec',
  'jsails',
  'npm',
  'npx',
  'node',
  'test',
  'shell',
]);

/**
 * Throws `unsupported_platform` when `verb` does not run on `platform`. A
 * missing verb (help or usage) is not refused.
 */
export function assertVerbSupported(
  verb: string | undefined,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32' || verb === undefined) return;
  if (WINDOWS_VERBS.has(verb)) return;
  throw new UnsupportedPlatformError('this jamal command does not run on Windows', {
    context: { platform },
    suggestion:
      'On Windows jamal runs the local services (up, down, logs, ps, exec); deploy from Linux or macOS',
  });
}
