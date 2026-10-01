/**
 * Write a file on the production server from data sent over ssh stdin.
 *
 * The contents never appear in an argv (where the remote `ps` would show
 * them): the remote command is a fixed `sh -c` script whose only parameter is
 * the destination path, and the payload arrives on stdin. The script creates
 * the parent directory, writes with `umask 077` (so a secrets file is mode
 * 0600 from the first byte), and renames a temporary file into place so a
 * reader never sees a half-written file.
 */

import { JsailsError } from '../../errors/jsails-error.js';
import { CONTROL_CHARS } from '../../support/strings.js';
import type { RemoteRunner } from './transport.js';

/** Why a remote file write was refused or failed. */
export type RemoteFileErrorCode = 'invalid_path' | 'io_failed';

/** Raised for a refused path or a failed write. Value-free. */
export class RemoteFileError extends JsailsError {
  constructor(
    readonly code: RemoteFileErrorCode,
    message: string,
    /** The remote exit code when the write ran and failed. */
    readonly exitCode?: number,
  ) {
    super(message);
  }
}

const WRITE_SCRIPT =
  'umask 077; mkdir -p -- "$(dirname -- "$1")" && cat > "$1.tmp" && mv -f -- "$1.tmp" "$1"';

/** Reject a destination that is empty, has control characters, or looks like an option. */
function assertPath(path: string): void {
  if (path.length === 0 || CONTROL_CHARS.test(path) || path.startsWith('-')) {
    throw new RemoteFileError(
      'invalid_path',
      'a remote file path must be non-empty, free of control characters, and not start with "-"',
    );
  }
}

/** The remote argv that writes stdin to `path`. */
export function remoteWriteFileArgv(path: string): readonly string[] {
  assertPath(path);
  return ['sh', '-c', WRITE_SCRIPT, 'sh', path];
}

/** Write `contents` to `path` on `server`; throws a value-free error on failure. */
export async function writeRemoteFile(
  remote: RemoteRunner,
  server: string,
  path: string,
  contents: string,
): Promise<void> {
  const result = await remote.run(server, remoteWriteFileArgv(path), { stdin: contents });
  if (result.exitCode !== 0) {
    throw new RemoteFileError(
      'io_failed',
      `the remote file write exited with code ${result.exitCode}`,
      result.exitCode,
    );
  }
}
