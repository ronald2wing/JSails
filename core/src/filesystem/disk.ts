/**
 * The `Disk` contract: a keyed blob store over relative POSIX-style paths.
 *
 * A disk stores named files (`put`) and reads them back by key (`get`); every
 * key is a relative path using forward slashes (`docs/report.txt`) — absolute
 * paths, `..`/`.` segments, backslashes, drive prefixes, and control characters
 * are rejected. Implementations own their persistence: `@jsails/filesystem`
 * ships `LocalDisk` (the real filesystem) and `MemoryDisk` (bytes in memory).
 *
 * The contract deliberately exposes no absolute path and no `path()` accessor:
 * callers address content by key only, and a disk never leaks where its files
 * live. `get` returns raw bytes; the optional `contentType` on `put` is
 * validated and accepted for forward compatibility but is not persisted (the
 * v1 `get` returns bytes only), so it carries no state and no promise of a
 * metadata round-trip.
 *
 * Every failure that reaches a caller is a value-free {@link DiskError}: no key,
 * path, or data content is ever embedded in a message. Construction-time option
 * mistakes throw `TypeError` instead, matching the other factory helpers.
 */

import { JsailsError } from '../errors/jsails-error.js';

/** Data accepted by `put`: raw bytes, or a UTF-8 string. */
export type DiskData = Uint8Array | string;

/** Options for {@link Disk.put}. */
export interface DiskPutOptions {
  /** Advisory MIME type. Validated but not persisted in the v1 contract. */
  readonly contentType?: string;
}

/** A keyed blob store over relative POSIX-style paths. */
export interface Disk {
  /** Atomically store `data` under `relativePath`. */
  put(relativePath: string, data: DiskData, options?: DiskPutOptions): Promise<void>;
  /** Read the raw bytes stored under `relativePath`. */
  get(relativePath: string): Promise<Uint8Array>;
  /** Whether a file exists at `relativePath`. */
  exists(relativePath: string): Promise<boolean>;
  /** Remove the file at `relativePath`; a no-op when absent. */
  delete(relativePath: string): Promise<void>;
  /** Sorted keys under `prefix` (recursive), or every key when omitted. */
  list(prefix?: string): Promise<readonly string[]>;
  /** Byte size of the file at `relativePath`. */
  size(relativePath: string): Promise<number>;
}

/**
 * True when `value` structurally implements {@link Disk}. Disks are plain
 * objects from any package, so a caller that accepts one checks the shape
 * rather than a class.
 */
export function isDisk(value: unknown): value is Disk {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<Disk>;
  return (
    typeof candidate.put === 'function' &&
    typeof candidate.get === 'function' &&
    typeof candidate.exists === 'function' &&
    typeof candidate.delete === 'function' &&
    typeof candidate.list === 'function' &&
    typeof candidate.size === 'function'
  );
}

/** Machine-readable reason for a {@link DiskError}. */
export type DiskErrorCode = 'invalid_key' | 'not_found' | 'too_large' | 'io_failed';

/** Raised for every disk failure that reaches a caller. Messages are value-free. */
export class DiskError extends JsailsError {
  constructor(
    readonly code: DiskErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
