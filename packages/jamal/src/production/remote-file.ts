/**
 * Write a file on the production server from data sent over ssh stdin.
 *
 * The contents never appear in an argv (where the remote `ps` would show
 * them): the remote command is a fixed `sh -c` script whose only parameter is
 * the destination path, and the payload arrives on stdin. The script creates
 * the parent directory, writes with `umask 077` (so a secrets file is mode
 * 0600 from the first byte), and renames a temporary file into place so a
 * reader never sees a half-written file.
 *
 * A dropped ssh connection can end stdin early without failing `cat`, which
 * would move a truncated file into place. So stdin starts with one header
 * line, `<byte count> <sha-256 hex>`, followed by the payload, and the script
 * checks the temporary file against both before the rename; on a mismatch it
 * removes the temporary file and exits {@link INTEGRITY_EXIT}. The header
 * travels on stdin rather than in the argv because a digest of a short secret
 * in the remote `ps` output is enough to recover the secret by guessing.
 */

import { createHash } from 'node:crypto';

import { JsailsError, CONTROL_CHARS } from 'jsails/support';
import type { RemoteRunner } from './transport.js';

/** Why a remote file write was refused or failed. */
export type RemoteFileErrorCode =
  'invalid_path' | 'io_failed' | 'integrity_failed' | 'missing_digest_tool';

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

/** The script's exit status when the received payload does not match its header. */
const INTEGRITY_EXIT = 4;

/** The script's exit status when the server has neither `sha256sum` nor `shasum`. */
const NO_DIGEST_TOOL_EXIT = 5;

/**
 * Read the header line, write the rest of stdin to `$1.tmp`, and rename it
 * into place only when its size and SHA-256 match the header. POSIX `read`
 * consumes stdin only up to the newline, so `cat` receives exactly the payload.
 */
const WRITE_SCRIPT = [
  'umask 077',
  `IFS=' ' read -r size sum || exit ${INTEGRITY_EXIT}`,
  'mkdir -p -- "$(dirname -- "$1")" || exit 3',
  't="$1.tmp"',
  'cat > "$t" || { rm -f -- "$t"; exit 3; }',
  'if command -v sha256sum >/dev/null 2>&1; then d=$(sha256sum < "$t")',
  'elif command -v shasum >/dev/null 2>&1; then d=$(shasum -a 256 < "$t")',
  `else rm -f -- "$t"; exit ${NO_DIGEST_TOOL_EXIT}; fi`,
  'n=$(wc -c < "$t" | tr -d " ")',
  `[ "$n" = "$size" ] && [ "\${d%% *}" = "$sum" ] || { rm -f -- "$t"; exit ${INTEGRITY_EXIT}; }`,
  'mv -f -- "$t" "$1"',
].join('; ');

/** Reject a destination that is empty, has control characters, or looks like an option. */
function assertPath(path: string): void {
  if (path.length === 0 || CONTROL_CHARS.test(path) || path.startsWith('-')) {
    throw new RemoteFileError(
      'invalid_path',
      'a remote file path must be non-empty, free of control characters, and not start with "-"',
    );
  }
}

/** The remote argv that writes stdin (header line, then payload) to `path`. */
export function remoteWriteFileArgv(path: string): readonly string[] {
  assertPath(path);
  return ['sh', '-c', WRITE_SCRIPT, 'sh', path];
}

/** The stdin for {@link remoteWriteFileArgv}: the integrity header, then `contents`. */
export function remoteWriteFileStdin(contents: string): string {
  const bytes = Buffer.from(contents, 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return `${bytes.length} ${digest}\n${contents}`;
}

/** Write `contents` to `path` on `server`; throws a value-free error on failure. */
export async function writeRemoteFile(
  remote: RemoteRunner,
  server: string,
  path: string,
  contents: string,
): Promise<void> {
  const result = await remote.run(server, remoteWriteFileArgv(path), {
    stdin: remoteWriteFileStdin(contents),
  });
  if (result.exitCode === INTEGRITY_EXIT) {
    throw new RemoteFileError(
      'integrity_failed',
      'the remote file arrived incomplete or altered and was not written',
      result.exitCode,
    );
  }
  if (result.exitCode === NO_DIGEST_TOOL_EXIT) {
    throw new RemoteFileError(
      'missing_digest_tool',
      'the server has neither sha256sum nor shasum to verify the remote file write',
      result.exitCode,
    );
  }
  if (result.exitCode !== 0) {
    throw new RemoteFileError(
      'io_failed',
      `the remote file write exited with code ${result.exitCode}`,
      result.exitCode,
    );
  }
}
