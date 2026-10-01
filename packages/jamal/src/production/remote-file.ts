/**
 * The one way jamal writes a file on a production server.
 *
 * {@link writeRemoteFile} sends the bytes over ssh stdin to the `file.write`
 * host script of `remote-op.ts`, so the contents never appear in an argv
 * (where the remote `ps` would show them): the argv carries only the
 * destination, the modes, and the lock directory of a fenced write. Stdin
 * starts with one header line, `<byte count> <sha-256 hex> [<lock token>]`,
 * then the payload. The script writes a unique temporary file beside the
 * destination, checks it against the header (a dropped connection ends stdin
 * early without failing `cat`, so the size and digest are what catch a
 * truncated payload), checks the fence and the precondition (create only,
 * or compare and replace), sets the mode, flushes the file to
 * disk, and renames it into place. The destination therefore holds either
 * its previous contents or the whole new payload, never a part of it, and
 * nothing is left behind on failure.
 *
 * Every failure is a value-free `jamal_remote_file.*` error: neither the
 * path nor any byte of the payload appears in it.
 */

import { createHash } from 'node:crypto';

import { CONTROL_CHARS } from 'jsails/support';
import { defineErrors, type ErrorRegistry } from 'jsails/errors';

import {
  WRITE_CHECKSUM_MISMATCH_EXIT,
  WRITE_EXPECT_ABSENT,
  WRITE_LOCK_LOST_EXIT,
  WRITE_NO_HASHER_EXIT,
  WRITE_PRECONDITION_EXIT,
  isFileMode,
  remoteOpArgv,
  runRemoteOp,
  type RemoteOpOf,
} from './remote-op.js';
import type { RemoteRunner } from './transport.js';

const REMOTE_FILE_ERRORS = {
  invalid_path: {
    kind: 'invalid',
    message:
      'a remote file path must be non-empty, free of control characters, and not start with "-"',
  },
  invalid_mode: {
    kind: 'invalid',
    message: 'a remote file mode must be a permission mode from 000 to 777',
  },
  invalid_lock: {
    kind: 'invalid',
    message: 'a remote write fence needs a lock directory path and a token of letters and digits',
  },
  invalid_expect: {
    kind: 'invalid',
    message: 'a remote write precondition must be "absent" or a lowercase SHA-256 hex digest',
  },
  precondition_failed: {
    kind: 'conflict',
    message: 'the remote file no longer holds what this run read, so it was not written',
    suggestion: 'something else changed the file during the run; run the verb again',
  },
  checksum_mismatch: {
    kind: 'unavailable',
    message: 'the remote file arrived incomplete or altered and was not written',
    suggestion: 'check the connection to the server and run the verb again',
  },
  lock_lost: {
    kind: 'conflict',
    message:
      'the deploy lock no longer holds the token this run wrote, so the remote file was not written',
    suggestion:
      'another run took the lock after it was force-released; let it finish, then run the verb again',
  },
  no_hasher: {
    kind: 'unavailable',
    message: 'the server has none of sha256sum, shasum and openssl to verify the remote file write',
    suggestion: 'install coreutils (sha256sum) or openssl on the server',
  },
  write_failed: {
    kind: 'unavailable',
    message: 'the remote file write exited with code {exitCode}',
    context: { exitCode: 'count' },
    suggestion: 'check the ssh connection, the disk, and the permissions of ~/.jamal on the server',
  },
} as const;

/**
 * `jamal_remote_file.*`: a remote file write was refused before it ran, or
 * ran and left the destination as it was.
 */
export const RemoteFileErrors: ErrorRegistry<'jamal_remote_file', typeof REMOTE_FILE_ERRORS> =
  defineErrors('jamal_remote_file', REMOTE_FILE_ERRORS);

/** The lock a fenced write checks: its directory and the token this run wrote there. */
export interface RemoteWriteFence {
  readonly dir: string;
  readonly token: string;
}

/** How {@link writeRemoteFile} writes. */
export interface RemoteWriteOptions {
  /** The file's permission mode (`0o600` for a secret only the ssh user reads). */
  readonly mode: number;
  /**
   * The mode of the file's directory, set on every write; absent leaves it
   * as it is (a directory the write creates is `0o700`).
   */
  readonly directoryMode?: number;
  /** Write only while this lock still holds this token. */
  readonly fence?: RemoteWriteFence;
  /**
   * Write only when the destination holds what the caller read:
   * {@link WRITE_EXPECT_ABSENT} (create only; an existing file is never
   * replaced) or the SHA-256 hex of its current bytes (compare and replace).
   */
  readonly expect?: string;
}

/** A lowercase SHA-256 hex digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The SHA-256 hex of `bytes`, as a write's `expect` names the bytes it replaces. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A lock token: what `lock.ts` generates, and nothing that could end the header line. */
const LOCK_TOKEN = /^[A-Za-z0-9]{1,128}$/;

/** Reject a destination that is empty, has control characters, or looks like an option. */
function assertPath(path: string): void {
  if (path.length === 0 || CONTROL_CHARS.test(path) || path.startsWith('-')) {
    throw new RemoteFileErrors.Error('invalid_path');
  }
}

/** The op a write performs, after checking its inputs. */
function writeOp(path: string, options: RemoteWriteOptions): RemoteOpOf<'file.write'> {
  assertPath(path);
  const { mode, directoryMode, fence, expect } = options;
  if (!isFileMode(mode) || (directoryMode !== undefined && !isFileMode(directoryMode))) {
    throw new RemoteFileErrors.Error('invalid_mode');
  }
  if (fence !== undefined) {
    if (!LOCK_TOKEN.test(fence.token)) throw new RemoteFileErrors.Error('invalid_lock');
    assertFenceDir(fence.dir);
  }
  if (expect !== undefined && expect !== WRITE_EXPECT_ABSENT && !SHA256_HEX.test(expect)) {
    throw new RemoteFileErrors.Error('invalid_expect');
  }
  return { kind: 'file.write', path, mode, directoryMode, lockDir: fence?.dir, expect };
}

function assertFenceDir(dir: string): void {
  if (dir.length === 0 || CONTROL_CHARS.test(dir) || dir.startsWith('-')) {
    throw new RemoteFileErrors.Error('invalid_lock');
  }
}

/** The remote argv that writes stdin (header line, then payload) to `path`. */
export function remoteWriteFileArgv(path: string, options: RemoteWriteOptions): readonly string[] {
  return remoteOpArgv(writeOp(path, options));
}

/**
 * The stdin for {@link remoteWriteFileArgv}: the header line (size, SHA-256,
 * and the fence's token when there is one), then `bytes`.
 */
export function remoteWriteFileStdin(bytes: Uint8Array, fence?: RemoteWriteFence): Buffer {
  const digest = sha256Hex(bytes);
  const header =
    fence === undefined
      ? `${bytes.length} ${digest}\n`
      : `${bytes.length} ${digest} ${fence.token}\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), bytes]);
}

/**
 * Write `bytes` to `path` on `server` as {@link RemoteWriteOptions} says.
 * Resolves once the whole file is in place; throws `jamal_remote_file.*`
 * otherwise, with the destination as it was.
 */
export async function writeRemoteFile(
  remote: RemoteRunner,
  server: string,
  path: string,
  bytes: Uint8Array,
  options: RemoteWriteOptions,
): Promise<void> {
  const op = writeOp(path, options);
  const result = await runRemoteOp(remote, server, op, {
    stdin: remoteWriteFileStdin(bytes, options.fence),
  });
  switch (result.exitCode) {
    case 0:
      return;
    case WRITE_CHECKSUM_MISMATCH_EXIT:
      throw new RemoteFileErrors.Error('checksum_mismatch');
    case WRITE_LOCK_LOST_EXIT:
      throw new RemoteFileErrors.Error('lock_lost');
    case WRITE_NO_HASHER_EXIT:
      throw new RemoteFileErrors.Error('no_hasher');
    case WRITE_PRECONDITION_EXIT:
      throw new RemoteFileErrors.Error('precondition_failed');
    default:
      throw new RemoteFileErrors.Error('write_failed', {
        exitCode: Math.max(0, Math.trunc(result.exitCode)),
      });
  }
}
