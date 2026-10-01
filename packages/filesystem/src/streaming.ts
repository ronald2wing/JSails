/**
 * Streaming and ranged access: an optional extension of the core
 * {@link Disk} contract that every disk in this package implements.
 *
 * The core contract moves whole buffers, which is the right default for small
 * blobs but makes a download hold the entire file in memory and rules out
 * HTTP `Range` requests. A {@link StreamingDisk} adds `stream` (a web
 * `ReadableStream` of the whole file or one byte range) and `putStream` (a
 * write fed from a stream, counted against a byte cap as it arrives). Callers
 * that accept any `Disk` check for the extension with {@link isStreamingDisk}
 * and fall back to `get`/`put` when it is absent.
 */

import type { Disk, DiskPutOptions } from 'jsails/filesystem';
import { JsailsError } from 'jsails/plugin-sdk';

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

/** True when `disk` implements the {@link StreamingDisk} extension. */
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

/**
 * Resolve a requested range against a file size into inclusive bounds. No
 * range means the whole file; an end past the file is clamped, as HTTP does;
 * a start at or past the end of a non-empty file is unsatisfiable.
 */
export function resolveRange(
  range: DiskRange | undefined,
  size: number,
): { start: number; end: number } {
  if (range === undefined) {
    return { start: 0, end: size - 1 };
  }
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new DiskRangeError('invalid_range', 'range start must be a non-negative integer');
  }
  if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) {
    throw new DiskRangeError('invalid_range', 'range end must be an integer at or after start');
  }
  if (start >= size) {
    throw new DiskRangeError('invalid_range', 'range starts past the end of the file');
  }
  return { start, end: Math.min(end ?? size - 1, size - 1) };
}

/** Iterate a web stream or an async iterable uniformly. */
export async function* chunksOf(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    yield* source;
  }
}
