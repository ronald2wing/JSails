/**
 * The `Disk` contract: a keyed object store that streams in both directions.
 *
 * Every disk implements all six methods; there is no optional capability to
 * probe for. A write takes a {@link ByteSource} and a required `maxBytes`, so
 * no caller can store an unbounded upload by omission, and it resolves to the
 * stored size and the SHA-256 of the bytes, computed while they flow. A write
 * is atomic: it either stores every byte or leaves nothing behind (no partial
 * object, temp file or multipart upload), and with `ifAbsent` it refuses with
 * `disk.conflict` when the key is taken, even against a racing writer.
 *
 * A read returns a {@link DiskObject} whose `stream` delivers the object or
 * one inclusive byte range of it; buffered access is the free function
 * `readBytes`, which takes its own `maxBytes`. `stat` answers `null` for a
 * missing key, `delete` is idempotent, and `list` returns one page of keys
 * under a prefix with an opaque cursor for the next. Keys follow the rules in
 * `disk-key.ts` on every disk.
 *
 * A short-lived URL that reads an object straight from its store is a
 * separate interface, `DiskUrlSigner`, which only stores with an origin of their
 * own implement.
 *
 * Every failure is a `disk.*` error from `DiskErrors`; none echoes a key, a
 * path or the data.
 */

import type { Sha256 } from './sha256.js';

/**
 * The bytes a write consumes: a buffer, a web stream, or any async iterable of
 * byte chunks (a Node `Readable` is one).
 *
 * @public
 */
export type ByteSource = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

/**
 * Options for {@link Disk.write}.
 *
 * @public
 */
export interface DiskWriteOptions {
  /** The most bytes the write accepts; one more rejects with `disk.too_large`. */
  readonly maxBytes: number;
  /** The media type to store with the object, on disks that persist one. */
  readonly contentType?: string;
  /** Refuse with `disk.conflict` when an object is already stored under the key. */
  readonly ifAbsent?: boolean;
  /** Abort the write; it then rejects with `disk.aborted` and stores nothing. */
  readonly signal?: AbortSignal;
}

/**
 * What a completed write stored.
 *
 * @public
 */
export interface DiskWriteResult {
  /** The stored size in bytes. */
  readonly size: number;
  /** The SHA-256 of the stored bytes. */
  readonly sha256: Sha256;
}

/**
 * An inclusive byte range, as HTTP `Range: bytes=start-end` states it.
 *
 * @public
 */
export interface DiskRange {
  readonly start: number;
  /** The last byte; omitted, or past the end, means the end of the object. */
  readonly end?: number;
}

/**
 * Options for {@link Disk.read}.
 *
 * @public
 */
export interface DiskReadOptions {
  /** Deliver only this range; one that starts past the end rejects with `disk.invalid_range`. */
  readonly range?: DiskRange;
  /** Abort the read, including a stream still being consumed. */
  readonly signal?: AbortSignal;
}

/**
 * An object, or one range of it, being read.
 *
 * @public
 */
export interface DiskObject {
  /** The delivered bytes. Cancel it to stop reading early. */
  readonly stream: ReadableStream<Uint8Array>;
  /** The whole object's size in bytes. */
  readonly size: number;
  /** The first delivered byte. */
  readonly start: number;
  /** The last delivered byte, inclusive; `start - 1` for an empty object. */
  readonly end: number;
  /** The stored media type, on disks that persist one. */
  readonly contentType?: string;
}

/**
 * What {@link Disk.stat} reports for a stored object.
 *
 * @public
 */
export interface DiskStat {
  readonly size: number;
  readonly modifiedAt: Date;
  /** The stored media type, on disks that persist one. */
  readonly contentType?: string;
}

/**
 * Options for {@link Disk.list}.
 *
 * @public
 */
export interface DiskListOptions {
  /** The cursor a previous page returned. */
  readonly cursor?: string;
  /** The most keys on this page, from 1 to {@link DISK_LIST_MAX_LIMIT}. */
  readonly limit: number;
}

/**
 * One page of {@link Disk.list}.
 *
 * @public
 */
export interface DiskListPage {
  /** Keys in ascending UTF-8 byte order. */
  readonly keys: readonly string[];
  /** Pass back for the next page; absent on the last page. */
  readonly cursor?: string;
}

/**
 * The largest page {@link Disk.list} returns, matching S3's `MaxKeys` ceiling.
 *
 * @public
 */
export const DISK_LIST_MAX_LIMIT = 1000;

/**
 * A keyed object store. See the module documentation for the guarantees every
 * implementation keeps; `runDiskContract` in `@jsails/filesystem/testing`
 * checks them for a custom disk.
 *
 * @public
 */
export interface Disk {
  /** Store every byte of `source` under `key`, atomically, and report its size and SHA-256. */
  write(key: string, source: ByteSource, options: DiskWriteOptions): Promise<DiskWriteResult>;
  /** Read the object under `key`, or one range of it; `disk.not_found` when absent. */
  read(key: string, options?: DiskReadOptions): Promise<DiskObject>;
  /** The object's size and modification time, or `null` when nothing is stored under `key`. */
  stat(key: string): Promise<DiskStat | null>;
  /** Remove the object under `key`; a no-op when absent. */
  delete(key: string): Promise<void>;
  /** Remove every object under `prefix/`. The prefix must be a non-empty key. */
  deletePrefix(prefix: string): Promise<void>;
  /** One page of the keys under `prefix/` (`''` for every key). */
  list(prefix: string, options: DiskListOptions): Promise<DiskListPage>;
}

/**
 * True when `value` structurally implements {@link Disk}. Disks are plain
 * objects from any package, so a caller that accepts one checks the shape.
 *
 * @public
 */
export function isDisk(value: unknown): value is Disk {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof Disk, unknown>>;
  return (
    typeof candidate.write === 'function' &&
    typeof candidate.read === 'function' &&
    typeof candidate.stat === 'function' &&
    typeof candidate.delete === 'function' &&
    typeof candidate.deletePrefix === 'function' &&
    typeof candidate.list === 'function'
  );
}
