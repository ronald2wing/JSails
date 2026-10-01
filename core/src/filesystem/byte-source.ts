/**
 * The write pipeline every disk shares: {@link meterByteSource} turns a
 * {@link ByteSource} into one stream of chunks that counts bytes against the
 * write's `maxBytes`, hashes them with SHA-256 as they pass, and stops on the
 * write's abort signal, so each disk only moves chunks to its store and every
 * disk reports the same size and digest for the same bytes.
 *
 * The signal is honoured while the source is between chunks, not only at
 * chunk boundaries: a source that stalls (a client that stops sending) is left
 * behind and cancelled when the signal fires, so an abort always ends the
 * write promptly.
 *
 * Server-only (`node:crypto`).
 */

import { createHash } from 'node:crypto';

import { KernelErrors } from '../errors/registry.js';
import type { ByteSource, DiskRange, DiskWriteResult } from './disk.js';
import { DiskErrors } from './disk-errors.js';
import type { Sha256 } from './sha256.js';

/**
 * Options for {@link meterByteSource}.
 *
 * @public
 */
export interface MeterOptions {
  /** The most bytes the source may yield; one more fails with `disk.too_large`. */
  readonly maxBytes: number;
  /** Ends the iteration with `disk.aborted`. */
  readonly signal?: AbortSignal;
}

/**
 * A source being metered. `chunks` may be iterated once; `result` is available
 * once it has ended.
 *
 * @public
 */
export interface MeteredByteSource {
  /** The source's chunks, counted, hashed and bounded. */
  readonly chunks: AsyncIterable<Uint8Array>;
  /** The size and SHA-256 of everything `chunks` yielded; only after it ended. */
  result(): DiskWriteResult;
}

interface ChunkReader {
  next(): Promise<IteratorResult<unknown>>;
  /** Stop the source. Never awaited past an abort: a stalled source may not settle. */
  cancel(reason: unknown): Promise<unknown>;
}

function chunkReader(source: ByteSource): ChunkReader {
  if (source instanceof Uint8Array) {
    let done = false;
    return {
      next: () => {
        if (done) return Promise.resolve({ done: true, value: undefined });
        done = true;
        return Promise.resolve({ done: false, value: source });
      },
      cancel: () => Promise.resolve(),
    };
  }
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    return {
      next: () => reader.read(),
      cancel: (reason) => reader.cancel(reason),
    };
  }
  const iterator = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  return {
    next: () => iterator.next(),
    cancel: async () => iterator.return?.(),
  };
}

/**
 * Throw `disk.invalid_option` unless `value` is a non-negative safe integer,
 * the shape every `maxBytes` takes.
 *
 * @public
 */
export function assertMaxBytes(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DiskErrors.Error('invalid_option', { option: 'maxBytes' });
  }
}

/** True when `source` is one of the shapes {@link ByteSource} admits. */
function isByteSource(source: unknown): source is ByteSource {
  if (source instanceof Uint8Array || source instanceof ReadableStream) return true;
  return (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Throw `disk.aborted` for `operation` when `signal` has fired, carrying the
 * signal's reason as the cause.
 *
 * @public
 */
export function throwIfDiskAborted(
  signal: AbortSignal | undefined,
  operation: 'write' | 'read',
): void {
  if (signal?.aborted === true) {
    throw new DiskErrors.Error('aborted', { operation }, { cause: signal.reason });
  }
}

/** Settle with the source's next step, or reject with `disk.aborted` when `signal` fires first. */
function nextOrAbort(
  reader: ChunkReader,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<unknown>> {
  const step = reader.next();
  if (signal === undefined) return step;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      // The source's pending step is abandoned; whatever it later settles
      // with belongs to a write that has already failed.
      step.catch(() => undefined);
      reject(new DiskErrors.Error('aborted', { operation: 'write' }, { cause: signal.reason }));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    step.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Meter `source` for a write: validate it, then yield its chunks while
 * counting them against `maxBytes`, hashing them, and watching `signal`.
 * Throws `disk.invalid_source` for anything but a {@link ByteSource},
 * `disk.invalid_option` for a bad `maxBytes`, and `disk.aborted` when the
 * signal has already fired; the iteration fails with `disk.too_large`,
 * `disk.aborted`, `disk.invalid_source` (a chunk that is not a `Uint8Array`)
 * or `disk.source_failed` (the source threw, kept as the cause). On any early
 * end the source is cancelled.
 *
 * @public
 */
export function meterByteSource(source: ByteSource, options: MeterOptions): MeteredByteSource {
  if (!isByteSource(source)) throw new DiskErrors.Error('invalid_source');
  assertMaxBytes(options.maxBytes);
  const { maxBytes, signal } = options;
  throwIfDiskAborted(signal, 'write');

  const hash = createHash('sha256');
  let size = 0;
  let result: DiskWriteResult | undefined;
  let started = false;

  async function* iterate(): AsyncGenerator<Uint8Array> {
    if (started) throw new KernelErrors.Error('internal');
    started = true;
    const reader = chunkReader(source);
    let ended = false;
    try {
      for (;;) {
        let step: IteratorResult<unknown>;
        try {
          step = await nextOrAbort(reader, signal);
        } catch (error) {
          if (DiskErrors.is(error)) throw error;
          throw new DiskErrors.Error('source_failed', {}, { cause: error });
        }
        if (step.done === true) {
          ended = true;
          result = Object.freeze({ size, sha256: hash.digest('hex') as Sha256 });
          return;
        }
        const chunk = step.value;
        if (!(chunk instanceof Uint8Array)) throw new DiskErrors.Error('invalid_source');
        size += chunk.byteLength;
        if (size > maxBytes) throw new DiskErrors.Error('too_large');
        hash.update(chunk);
        yield chunk;
      }
    } finally {
      if (!ended) {
        // Not awaited: an abandoned source may never settle (a stalled client),
        // and a cancel failure cannot change a write that has already failed.
        reader.cancel(signal?.reason).catch(() => undefined);
      }
    }
  }

  return {
    chunks: { [Symbol.asyncIterator]: iterate },
    result() {
      if (result === undefined) throw new KernelErrors.Error('internal');
      return result;
    },
  };
}

/**
 * Resolve a requested range against an object's size into inclusive bounds.
 * No range is the whole object (`end` is `-1` for an empty one); an end past
 * the object is clamped, as HTTP does; a malformed range, or one starting at
 * or past the end, throws `disk.invalid_range`.
 *
 * @public
 */
export function resolveDiskRange(
  range: DiskRange | undefined,
  size: number,
): { readonly start: number; readonly end: number } {
  if (range === undefined) return { start: 0, end: size - 1 };
  assertRangeShape(range);
  if (range.start >= size) throw new DiskErrors.Error('invalid_range');
  return { start: range.start, end: Math.min(range.end ?? size - 1, size - 1) };
}

/**
 * Throw `disk.invalid_range` unless `range` is a non-negative integer start
 * with an optional integer end at or after it. For stores that resolve the
 * range against the size themselves.
 *
 * @public
 */
export function assertRangeShape(range: DiskRange): void {
  if (range === null || typeof range !== 'object') throw new DiskErrors.Error('invalid_range');
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || start < 0) throw new DiskErrors.Error('invalid_range');
  if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) {
    throw new DiskErrors.Error('invalid_range');
  }
}
