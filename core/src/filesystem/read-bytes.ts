/**
 * Buffered reads over any {@link Disk}: {@link readBytes} and {@link readText}
 * collect an object into memory, bounded by a `maxBytes` the caller must state,
 * so no read path holds an object of unknown size by default.
 */

import { assertMaxBytes } from './byte-source.js';
import type { Disk } from './disk.js';
import { DiskErrors } from './disk-errors.js';

/**
 * Options for {@link readBytes} and {@link readText}.
 *
 * @public
 */
export interface ReadBytesOptions {
  /** The largest object accepted; a bigger one rejects with `disk.too_large` before it is read. */
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

/**
 * Read the whole object under `key` into memory. An object larger than
 * `maxBytes` rejects with `disk.too_large` without its bytes being read; a
 * stream that delivers more than its declared size is cut off the same way,
 * and one that ends short of it rejects with `disk.io_failed`.
 *
 * @public
 */
export async function readBytes(
  disk: Disk,
  key: string,
  options: ReadBytesOptions,
): Promise<Uint8Array> {
  assertMaxBytes(options?.maxBytes);
  const { maxBytes, signal } = options;
  const object = await disk.read(key, signal === undefined ? {} : { signal });
  if (object.size > maxBytes) {
    // The refusal is what the caller sees; a failed cancel adds nothing.
    await object.stream.cancel().catch(() => undefined);
    throw new DiskErrors.Error('too_large');
  }
  const bytes = new Uint8Array(object.size);
  let filled = 0;
  const reader = object.stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (filled + value.byteLength > bytes.byteLength) {
        throw new DiskErrors.Error('too_large');
      }
      bytes.set(value, filled);
      filled += value.byteLength;
    }
  } catch (error) {
    // The read's own failure is what the caller sees; a failed cancel adds nothing.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  // A stream that ends short of its declared size was truncated in transit.
  if (filled !== bytes.byteLength) throw new DiskErrors.Error('io_failed', { operation: 'read' });
  return bytes;
}

/**
 * Read the whole object under `key` as UTF-8 text, bounded like
 * {@link readBytes}. Malformed sequences decode to U+FFFD.
 *
 * @public
 */
export async function readText(
  disk: Disk,
  key: string,
  options: ReadBytesOptions,
): Promise<string> {
  return new TextDecoder().decode(await readBytes(disk, key, options));
}
