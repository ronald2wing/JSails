/**
 * Streaming and ranged access: an optional capability of the {@link Disk}
 * contract.
 *
 * The base contract moves whole buffers, which is the right default for small
 * blobs but makes a download hold the entire file in memory and rules out
 * HTTP `Range` requests. A {@link StreamingDisk} adds `stream` (a web
 * `ReadableStream` of the whole file or one byte range) and `putStream` (a
 * write fed from a stream, counted against a byte cap as it arrives). Callers
 * that accept any `Disk` check for the capability with {@link isStreamingDisk}
 * and fall back to `get`/`put` when it is absent.
 */

import { JsailsError } from '../errors/jsails-error.js';
import type { Disk, DiskPutOptions } from './disk.js';

/** An inclusive byte range, as HTTP `Range: bytes=start-end` expresses it. */
export interface DiskRange {
  readonly start: number;
  /** Inclusive end; omitted means "to the end of the file". */
  readonly end?: number;
}

/** Options for {@link StreamingDisk.stream}. */
export interface DiskStreamOptions {
  readonly range?: DiskRange;
}

/** A readable view of a stored file or one byte range of it. */
export interface DiskReadStream {
  readonly stream: ReadableStream<Uint8Array>;
  /** The whole file's size in bytes. */
  readonly size: number;
  /** First byte delivered. */
  readonly start: number;
  /** Last byte delivered (inclusive); `start - 1` for an empty file. */
  readonly end: number;
}

/** Options for {@link StreamingDisk.putStream}. */
export interface DiskPutStreamOptions extends DiskPutOptions {
  /**
   * Refuse the write with `too_large` once more than this many bytes arrive.
   * The cap is enforced while reading, so an oversized upload is never
   * buffered or stored in full.
   */
  readonly maxBytes?: number;
}

/** A disk that can read ranges and write from a stream. */
export interface StreamingDisk extends Disk {
  /** Open a stream over the file (or the requested range) at `relativePath`. */
  stream(relativePath: string, options?: DiskStreamOptions): Promise<DiskReadStream>;
  /** Store the bytes `source` yields under `relativePath`; returns the byte count. */
  putStream(
    relativePath: string,
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options?: DiskPutStreamOptions,
  ): Promise<number>;
}

/** True when `disk` implements the {@link StreamingDisk} capability. */
export function isStreamingDisk(disk: Disk): disk is StreamingDisk {
  const candidate = disk as Partial<StreamingDisk>;
  return typeof candidate.stream === 'function' && typeof candidate.putStream === 'function';
}

/** Why a range could not be served. */
export type DiskRangeErrorCode = 'invalid_range';

/** A requested range that is malformed or lies outside the file. Value-free. */
export class DiskRangeError extends JsailsError {
  constructor(
    readonly code: DiskRangeErrorCode,
    message: string,
  ) {
    super(message);
  }
}
