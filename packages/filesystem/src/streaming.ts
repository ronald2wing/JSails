/**
 * Streaming and ranged access for the disks in this package: the range
 * resolver and source iterator every `stream`/`putStream` implementation
 * shares. The capability itself ({@link StreamingDisk}, `isStreamingDisk`,
 * `DiskRangeError`) is part of the core `jsails/filesystem` contract; it is
 * re-exported here so existing imports from `@jsails/filesystem` keep working.
 */

import { DiskRangeError, type DiskRange } from 'jsails/filesystem';

export {
  DiskRangeError,
  isStreamingDisk,
  type DiskPutStreamOptions,
  type DiskRange,
  type DiskRangeErrorCode,
  type DiskReadStream,
  type DiskStreamOptions,
  type StreamingDisk,
} from 'jsails/filesystem';

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
