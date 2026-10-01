/**
 * The local half of `jamal backup` and `jamal restore`: writing a dump to its
 * file atomically with a SHA-256 sidecar, and verifying a file before it is
 * restored.
 *
 * A backup streams into `.<name>.partial` (created exclusively, mode 0600,
 * in a mode-0700 directory) while its SHA-256 and leading bytes are taken on
 * the way through; the data is fsynced, and the file is linked to its final
 * name only once the dump completed and its content is recognized as the
 * accessory's kind, so a reader never sees a half-written or foreign file and
 * an existing backup is never overwritten. The sidecar `<name>.sha256` is in
 * the `sha256sum` format (`<hex>  <name>`), so `sha256sum -c` checks a backup
 * without jamal; it is published before the dump, so a dump never exists
 * without one.
 *
 * Before a restore, the file must have its sidecar, the sidecar must name
 * this file, the content must hash to it, and the content must be a dump of
 * a known kind. Every failure is a value-free {@link BackupError}: no path
 * and no digest is echoed.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readFile, rm, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Writable } from 'node:stream';

import { isErrno } from '../thrown-value.js';
import { BACKUP_HEAD_BYTES, BackupError, detectBackupKind, type BackupKind } from './backup.js';

/** The extension of the checksum file beside each backup. */
export const CHECKSUM_EXTENSION = '.sha256';

/** A finished backup: where it is, its size, and its digest. */
export interface BackupWritten {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** An open backup file: the stream to write the dump into, then commit or discard. */
export interface BackupSink {
  /** The partial file, so an interrupt can remove it synchronously. */
  readonly partialPath: string;
  /** Receives the dump; its end fsyncs the data. */
  readonly stream: Writable;
  /** Publish the finished dump under its final name, after checking it is a `kind` dump. */
  commit(kind: BackupKind): Promise<BackupWritten>;
  /** Remove the partial file; safe to call after a failed write or commit. */
  discard(): Promise<void>;
}

/** The sidecar line for a file: `sha256sum`'s own format. */
export function checksumLine(sha256: string, fileName: string): string {
  return `${sha256}  ${fileName}\n`;
}

/** A sidecar line: 64 lowercase hex digits, two spaces (or space and `*`), the file name. */
const CHECKSUM_LINE = /^([0-9a-f]{64}) [ *]([^\n]+)\n?$/;

/**
 * Create `<dir>/.<fileName>.partial` exclusively and return a sink that
 * hashes, measures, and writes everything it receives.
 */
export async function openBackupSink(dir: string, fileName: string): Promise<BackupSink> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new BackupError('write_failed', 'the backup directory could not be created', {
      cause: error,
    });
  }
  const finalPath = join(dir, fileName);
  const partialPath = join(dir, `.${fileName}.partial`);
  let handle: FileHandle;
  try {
    handle = await open(partialPath, 'wx', 0o600);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new BackupError('exists', 'a backup with this name is already being written');
    }
    throw new BackupError('write_failed', 'the backup file could not be created', {
      cause: error,
    });
  }

  const hash = createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };

  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      if (head.length < BACKUP_HEAD_BYTES) {
        head = Buffer.concat([head, chunk.subarray(0, BACKUP_HEAD_BYTES - head.length)]);
      }
      writeAll(handle, chunk).then(
        () => callback(),
        (error: unknown) => callback(error as Error),
      );
    },
    final(callback) {
      handle.sync().then(
        () => callback(),
        (error: unknown) => callback(error as Error),
      );
    },
  });

  return {
    partialPath,
    stream,
    async commit(kind) {
      await close();
      if (bytes === 0) {
        throw new BackupError('empty_dump', 'the accessory produced an empty dump');
      }
      if (detectBackupKind(head) !== kind) {
        throw new BackupError(
          'unknown_format',
          `the accessory's output is not a ${kind} dump, so it was not kept`,
        );
      }
      const sha256 = hash.digest('hex');
      await publishChecksum(finalPath, checksumLine(sha256, fileName));
      try {
        await link(partialPath, finalPath);
      } catch (error) {
        await rm(`${finalPath}${CHECKSUM_EXTENSION}`, { force: true });
        throw isErrno(error, 'EEXIST')
          ? new BackupError('exists', 'a backup with this name already exists')
          : new BackupError('write_failed', 'the backup file could not be published', {
              cause: error,
            });
      }
      await unlink(partialPath);
      await syncDirectory(dir);
      return { path: finalPath, bytes, sha256 };
    },
    async discard() {
      try {
        await close();
      } catch {
        // The file is removed next; a failed close changes nothing about that.
      }
      await rm(partialPath, { force: true });
    },
  };
}

/**
 * Write all of `chunk`: one `write` may write only part of it (a volume
 * filling up), and the digest already covers every byte, so a short write
 * must continue or fail, never pass silently.
 */
async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset);
    if (bytesWritten === 0) {
      throw new BackupError('write_failed', 'the backup file could not be written');
    }
    offset += bytesWritten;
  }
}

/**
 * Write the sidecar beside `finalPath` through its own partial file, linked
 * into place so an existing sidecar is never replaced.
 */
async function publishChecksum(finalPath: string, line: string): Promise<void> {
  const target = `${finalPath}${CHECKSUM_EXTENSION}`;
  const partial = join(dirname(target), `.${basename(target)}.partial`);
  try {
    const handle = await open(partial, 'wx', 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(partial, target);
  } catch (error) {
    throw isErrno(error, 'EEXIST')
      ? new BackupError('exists', 'a backup with this name already exists')
      : new BackupError('write_failed', 'the backup checksum file could not be written', {
          cause: error,
        });
  } finally {
    await rm(partial, { force: true });
  }
}

/**
 * fsync a directory so the links in it survive a crash. Windows has no
 * directory handle to sync (NTFS journals the metadata itself), and opening
 * one fails, so there it is skipped.
 */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A backup file that passed {@link verifyBackupFile}. */
export interface VerifiedBackup {
  readonly kind: BackupKind;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Check a backup file against its `.sha256` sidecar and identify its kind by
 * content. Throws a value-free {@link BackupError} when the sidecar is
 * missing, malformed, or names another file, when the digest differs, or when
 * the content is not a dump jamal recognizes.
 */
export async function verifyBackupFile(path: string): Promise<VerifiedBackup> {
  let line: string;
  try {
    line = await readFile(`${path}${CHECKSUM_EXTENSION}`, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new BackupError('missing_checksum', 'the backup file has no .sha256 file beside it', {
        suggestion: 'Restore a file written by "jamal backup", which writes both',
      });
    }
    throw new BackupError('unreadable', 'the backup checksum file could not be read', {
      cause: error,
    });
  }
  const match = CHECKSUM_LINE.exec(line);
  if (match === null || match[2] !== basename(path)) {
    throw new BackupError(
      'invalid_checksum',
      'the .sha256 file is not a sha256sum line for this backup file',
    );
  }

  const hash = createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      bytes += chunk.length;
      if (head.length < BACKUP_HEAD_BYTES) {
        head = Buffer.concat([head, chunk.subarray(0, BACKUP_HEAD_BYTES - head.length)]);
      }
    }
  } catch (error) {
    throw new BackupError('unreadable', 'the backup file could not be read', { cause: error });
  }
  const sha256 = hash.digest('hex');
  if (sha256 !== match[1]) {
    throw new BackupError(
      'checksum_mismatch',
      'the backup file does not match its .sha256 file; it is damaged or was changed',
    );
  }
  const kind = detectBackupKind(head);
  if (kind === undefined) {
    throw new BackupError('unknown_format', 'the backup file is not a dump jamal recognizes');
  }
  return { kind, sha256, bytes };
}
