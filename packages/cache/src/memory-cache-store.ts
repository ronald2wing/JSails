/**
 * The in-memory {@link CacheStore}: a least-recently-used cache bounded by
 * bytes and by entries.
 *
 * Entries sit in a `Map` in recency order: a read (`get`, `getMany`) or a
 * write moves an entry to the most recent end, and a refused `add` leaves it
 * where it was. An entry's size is the UTF-8 length of its key plus the length
 * of its value (UTF-8 for a string). When a write takes the store over either
 * budget, every expired entry goes first, found through a lazy expiry heap,
 * and then the least recently used entries, never the one just written; an
 * entry that alone exceeds `maxBytes` is refused with `cache.too_large` before
 * anything changes. Values are copied in and out, so a caller mutating a
 * `Uint8Array` never changes an entry.
 *
 * The store guarantees nothing across processes: each process has its own
 * entries. Locks and rate-limit state do not belong here (see `LeaseStore`).
 */

import { CacheErrors, type CacheStore, type CacheValue } from 'jsails/cache';
import { isPositiveInteger } from 'jsails/plugin-sdk';

import { rootCacheView, type CacheKeyspace } from './cache-view.js';
import { ExpiryHeap } from './expiry-heap.js';

/** Default byte budget: 64 MiB. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Default entry budget, which bounds per-entry bookkeeping beside the bytes. */
const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * Options for {@link MemoryCacheStore}.
 *
 * @public
 */
export interface MemoryCacheStoreOptions {
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Byte budget over keys and values. Defaults to 64 MiB. */
  readonly maxBytes?: number;
  /** Entry budget. Defaults to 100 000. */
  readonly maxEntries?: number;
}

/**
 * What a {@link MemoryCacheStore} holds right now, expired entries not yet
 * swept included.
 *
 * @public
 */
export interface MemoryCacheUsage {
  readonly entries: number;
  readonly bytes: number;
}

interface Entry {
  readonly value: CacheValue;
  readonly expiresAt: number;
  readonly bytes: number;
}

/** The UTF-8 length of `text`, without allocating its encoding. */
function utf8Length(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) length += 1;
    else if (unit < 0x800) length += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else length += 3;
  }
  return length;
}

/** The bytes an entry is charged: its key and its value, both as UTF-8. */
export function memoryEntryBytes(key: string, value: CacheValue): number {
  return utf8Length(key) + (typeof value === 'string' ? utf8Length(value) : value.byteLength);
}

/** A private copy of a byte value; strings are immutable and kept as they are. */
function copyValue(value: CacheValue): CacheValue {
  return typeof value === 'string' ? value : new Uint8Array(value);
}

class MemoryKeyspace implements CacheKeyspace {
  readonly #now: () => number;
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry>();
  readonly #expiries = new ExpiryHeap();
  #bytes = 0;
  closed = false;

  constructor(now: () => number, maxBytes: number, maxEntries: number) {
    this.#now = now;
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
  }

  usage(): MemoryCacheUsage {
    return Object.freeze({ entries: this.#entries.size, bytes: this.#bytes });
  }

  async get(key: string): Promise<CacheValue | null> {
    return this.#read(key, this.#now());
  }

  async getMany(keys: readonly string[]): Promise<(CacheValue | null)[]> {
    const now = this.#now();
    return keys.map((key) => this.#read(key, now));
  }

  async set(key: string, value: CacheValue, ttlMs: number): Promise<void> {
    this.#put(key, this.#entry(key, value, ttlMs));
  }

  async add(key: string, value: CacheValue, ttlMs: number): Promise<boolean> {
    const entry = this.#entry(key, value, ttlMs);
    if (this.#live(key, this.#now()) !== undefined) return false;
    this.#put(key, entry);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.#remove(key);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#entries.clear();
    this.#expiries.clear();
    this.#bytes = 0;
  }

  #read(key: string, now: number): CacheValue | null {
    const entry = this.#live(key, now);
    if (entry === undefined) return null;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return copyValue(entry.value);
  }

  /** The unexpired entry under `key`; an expired one is dropped on the way. */
  #live(key: string, now: number): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (now >= entry.expiresAt) {
      this.#remove(key);
      return undefined;
    }
    return entry;
  }

  #entry(key: string, value: CacheValue, ttlMs: number): Entry {
    const bytes = memoryEntryBytes(key, value);
    if (bytes > this.#maxBytes) throw new CacheErrors.Error('too_large');
    return { value: copyValue(value), expiresAt: this.#now() + ttlMs, bytes };
  }

  #put(key: string, entry: Entry): void {
    this.#remove(key);
    this.#entries.set(key, entry);
    this.#bytes += entry.bytes;
    this.#expiries.push(entry.expiresAt, key);
    this.#enforce(key);
    this.#expiries.compact(this.#entries.size, () => this.#expiryPairs());
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }

  #within(): boolean {
    return this.#bytes <= this.#maxBytes && this.#entries.size <= this.#maxEntries;
  }

  /** Expired entries first, then least recently used, never `written`. */
  #enforce(written: string): void {
    if (this.#within()) return;
    const now = this.#now();
    this.#expiries.drain(now, (key) => {
      const entry = this.#entries.get(key);
      if (entry !== undefined && entry.expiresAt <= now) this.#remove(key);
    });
    for (const key of this.#entries.keys()) {
      if (this.#within()) return;
      if (key !== written) this.#remove(key);
    }
  }

  *#expiryPairs(): Iterable<readonly [string, number]> {
    for (const [key, entry] of this.#entries) yield [key, entry.expiresAt];
  }
}

/**
 * In-memory cache store. Construct with
 * `new MemoryCacheStore({ now?, maxBytes?, maxEntries? })`; it holds no
 * external resource, and `close` drops every entry.
 *
 * @public
 */
export class MemoryCacheStore implements CacheStore {
  readonly #space: MemoryKeyspace;
  readonly #root: CacheStore;

  constructor(options: MemoryCacheStoreOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new CacheErrors.Error('invalid_option', { option: 'MemoryCacheStore' });
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new CacheErrors.Error('invalid_option', { option: 'now' });
    }
    if (options.maxBytes !== undefined && !isPositiveInteger(options.maxBytes)) {
      throw new CacheErrors.Error('invalid_option', { option: 'maxBytes' });
    }
    if (options.maxEntries !== undefined && !isPositiveInteger(options.maxEntries)) {
      throw new CacheErrors.Error('invalid_option', { option: 'maxEntries' });
    }
    this.#space = new MemoryKeyspace(
      options.now ?? (() => Date.now()),
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    );
    this.#root = rootCacheView(this.#space);
  }

  /** The entries and bytes held now. */
  usage(): MemoryCacheUsage {
    return this.#space.usage();
  }

  get(key: string): Promise<CacheValue | null> {
    return this.#root.get(key);
  }

  getMany(keys: readonly string[]): Promise<(CacheValue | null)[]> {
    return this.#root.getMany(keys);
  }

  set(key: string, value: CacheValue, ttlMs: number): Promise<void> {
    return this.#root.set(key, value, ttlMs);
  }

  add(key: string, value: CacheValue, ttlMs: number): Promise<boolean> {
    return this.#root.add(key, value, ttlMs);
  }

  delete(key: string): Promise<void> {
    return this.#root.delete(key);
  }

  namespace(name: string): CacheStore {
    return this.#root.namespace(name);
  }

  close(): Promise<void> {
    return this.#root.close();
  }
}
