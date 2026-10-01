/**
 * In-memory disk: a {@link Disk} over a `Map`, for tests, demos and
 * single-process use. It keeps the whole contract (SHA-256 from every write,
 * `ifAbsent`, ranges, paged listing in UTF-8 byte order, content types) and an
 * optional byte quota, and holds no external resource, so it needs no close.
 * Stored bytes are copies: a caller mutating its buffer after a write, or the
 * chunks of a read, cannot change what is stored.
 */

import {
  assertDiskKey,
  assertDiskPrefix,
  DiskErrors,
  meterByteSource,
  resolveDiskRange,
  throwIfDiskAborted,
  type ByteSource,
  type Disk,
  type DiskListOptions,
  type DiskListPage,
  type DiskObject,
  type DiskReadOptions,
  type DiskStat,
  type DiskWriteOptions,
  type DiskWriteResult,
} from 'jsails/filesystem';

import {
  assertListOptions,
  assertReadSignal,
  assertWriteOptions,
  isOptionsObject,
  quotaOption,
} from './disk-validation.js';
import { compareKeys, decodeCursor, encodeCursor, isUnderPrefix } from './list-order.js';

/**
 * Options for {@link MemoryDisk}.
 *
 * @public
 */
export interface MemoryDiskOptions {
  /** A cap on the total stored bytes; a write that would pass it fails with `disk.too_large`. */
  readonly maxBytes?: number;
  /** The clock `modifiedAt` reads. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly modifiedAt: Date;
}

/**
 * A disk held in process memory. Construct with `new MemoryDisk({ maxBytes?, now? })`.
 *
 * @public
 */
export class MemoryDisk implements Disk {
  readonly #quota: number | undefined;
  readonly #now: () => Date;
  readonly #objects = new Map<string, StoredObject>();
  #total = 0;

  constructor(options: MemoryDiskOptions = {}) {
    if (!isOptionsObject(options))
      throw new DiskErrors.Error('invalid_option', { option: 'options' });
    this.#quota = quotaOption(options.maxBytes);
    const now: unknown = options.now ?? (() => new Date());
    if (typeof now !== 'function') throw new DiskErrors.Error('invalid_option', { option: 'now' });
    this.#now = now as () => Date;
  }

  async write(
    key: string,
    source: ByteSource,
    options: DiskWriteOptions,
  ): Promise<DiskWriteResult> {
    assertDiskKey(key);
    assertWriteOptions(options);
    // With a quota, no more is buffered than could fit; the binding check
    // runs below, against the total at the moment of the store.
    const room =
      this.#quota === undefined
        ? options.maxBytes
        : Math.min(
            options.maxBytes,
            this.#quota - this.#total + (this.#objects.get(key)?.bytes.byteLength ?? 0),
          );
    const metered = meterByteSource(source, {
      maxBytes: Math.max(room, 0),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of metered.chunks) chunks.push(chunk);
    // Concatenating copies every chunk, so the stored bytes are the disk's own.
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const result = metered.result();
    // The checks below and the store run in one synchronous step, so racing
    // writes cannot both pass `ifAbsent` or the quota.
    throwIfDiskAborted(options.signal, 'write');
    const existing = this.#objects.get(key);
    if (options.ifAbsent === true && existing !== undefined) {
      throw new DiskErrors.Error('conflict');
    }
    const projected = this.#total - (existing?.bytes.byteLength ?? 0) + bytes.byteLength;
    if (this.#quota !== undefined && projected > this.#quota) {
      throw new DiskErrors.Error('too_large');
    }
    this.#objects.set(key, {
      bytes,
      contentType: options.contentType,
      modifiedAt: this.#now(),
    });
    this.#total = projected;
    return result;
  }

  async read(key: string, options: DiskReadOptions = {}): Promise<DiskObject> {
    assertDiskKey(key);
    assertReadSignal(options.signal);
    throwIfDiskAborted(options.signal, 'read');
    const object = this.#objects.get(key);
    if (object === undefined) throw new DiskErrors.Error('not_found');
    const size = object.bytes.byteLength;
    const { start, end } = resolveDiskRange(options.range, size);
    return {
      stream: new Blob([object.bytes.slice(start, end + 1)]).stream(),
      size,
      start,
      end,
      ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
    };
  }

  async stat(key: string): Promise<DiskStat | null> {
    assertDiskKey(key);
    const object = this.#objects.get(key);
    if (object === undefined) return null;
    return {
      size: object.bytes.byteLength,
      modifiedAt: new Date(object.modifiedAt),
      ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
    };
  }

  async delete(key: string): Promise<void> {
    assertDiskKey(key);
    const object = this.#objects.get(key);
    if (object === undefined) return;
    this.#objects.delete(key);
    this.#total -= object.bytes.byteLength;
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertDiskKey(prefix);
    for (const [key, object] of this.#objects) {
      if (isUnderPrefix(key, prefix)) {
        this.#objects.delete(key);
        this.#total -= object.bytes.byteLength;
      }
    }
  }

  async list(prefix: string, options: DiskListOptions): Promise<DiskListPage> {
    assertDiskPrefix(prefix);
    assertListOptions(options);
    const after = decodeCursor(options.cursor);
    const keys = [...this.#objects.keys()]
      .filter(
        (key) => isUnderPrefix(key, prefix) && (after === undefined || compareKeys(key, after) > 0),
      )
      .sort(compareKeys);
    const page = keys.slice(0, options.limit);
    const last = page.at(-1);
    return keys.length > page.length && last !== undefined
      ? { keys: page, cursor: encodeCursor(last) }
      : { keys: page };
  }
}
