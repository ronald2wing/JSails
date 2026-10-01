/**
 * Map-backed doubles of the cache contracts for core's own tests, which cannot
 * import `@jsails/cache`: a {@link MapCacheStore} that records every call and
 * can be made to fail or to hold a read, a {@link MapLeaseStore}, and
 * {@link cacheServiceOf}, which wraps a store as the `cacheToken` service
 * (every namespace is the store itself, so a test reads the keys the code
 * under test wrote). Both stores pass the conformance suites in
 * `map-stores.test.ts`.
 */

import { randomUUID } from 'node:crypto';

import {
  assertCacheKey,
  assertCacheNamespace,
  assertCacheValue,
  assertTtlMs,
  type CacheStore,
  type CacheValue,
} from '../../src/cache/store.js';
import { assertLease, type Lease, type LeaseStore } from '../../src/cache/lease.js';
import { CacheErrors } from '../../src/cache/cache-errors.js';
import type { CacheService } from '../../src/cache/tokens.js';

interface Entry {
  readonly value: CacheValue;
  readonly expiresAt: number;
}

function copy(value: CacheValue): CacheValue {
  return typeof value === 'string' ? value : new Uint8Array(value);
}

/** A `getMany` held by {@link MapCacheStore.holdNextGetMany}. */
export interface HeldRead {
  /** Resolves once the read has taken its values. */
  readonly began: Promise<void>;
  /** Let the read answer. */
  readonly release: () => void;
}

/** A TTL-aware, unbounded, Map-backed cache store. */
export class MapCacheStore implements CacheStore {
  readonly entries: Map<string, Entry>;
  /** Every operation, in order, as `<operation>` (one round trip each). */
  readonly calls: string[];
  readonly #prefix: string;
  readonly #now: () => number;
  readonly #children = new Map<string, MapCacheStore>();
  /** When set, every operation rejects with this error. */
  failWith: Error | undefined;
  #closed = false;
  #heldGetMany: { readonly begin: () => void; readonly released: Promise<void> } | undefined;

  constructor(
    now: () => number = () => Date.now(),
    shared?: { entries: Map<string, Entry>; calls: string[]; prefix: string },
  ) {
    this.#now = now;
    this.entries = shared?.entries ?? new Map();
    this.calls = shared?.calls ?? [];
    this.#prefix = shared?.prefix ?? '';
  }

  /** The number of `set` and successful `add` calls on this view. */
  writes = 0;

  #enter(operation: string): void {
    this.calls.push(operation);
    if (this.#closed) throw new CacheErrors.Error('closed', { store: 'cache' });
    if (this.failWith !== undefined) throw this.failWith;
  }

  #live(key: string): Entry | undefined {
    const entry = this.entries.get(this.#prefix + key);
    if (entry === undefined) return undefined;
    if (this.#now() >= entry.expiresAt) {
      this.entries.delete(this.#prefix + key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<CacheValue | null> {
    assertCacheKey(key);
    this.#enter('get');
    const entry = this.#live(key);
    return entry === undefined ? null : copy(entry.value);
  }

  /**
   * Hold the next `getMany` of this view: it reads the entries at once, then
   * `began` resolves, and it answers only once `release` is called, as a slow
   * round trip would.
   */
  holdNextGetMany(): HeldRead {
    let release!: () => void;
    let begin!: () => void;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#heldGetMany = { begin, released };
    return { began, release };
  }

  async getMany(keys: readonly string[]): Promise<(CacheValue | null)[]> {
    for (const key of keys) assertCacheKey(key);
    this.#enter('getMany');
    const held = this.#heldGetMany;
    this.#heldGetMany = undefined;
    const values = keys.map((key) => {
      const entry = this.#live(key);
      return entry === undefined ? null : copy(entry.value);
    });
    if (held !== undefined) {
      held.begin();
      await held.released;
    }
    return values;
  }

  async set(key: string, value: CacheValue, ttlMs: number): Promise<void> {
    assertCacheKey(key);
    assertCacheValue(value);
    assertTtlMs(ttlMs);
    this.#enter('set');
    this.writes += 1;
    this.entries.set(this.#prefix + key, { value: copy(value), expiresAt: this.#now() + ttlMs });
  }

  async add(key: string, value: CacheValue, ttlMs: number): Promise<boolean> {
    assertCacheKey(key);
    assertCacheValue(value);
    assertTtlMs(ttlMs);
    this.#enter('add');
    if (this.#live(key) !== undefined) return false;
    this.writes += 1;
    this.entries.set(this.#prefix + key, { value: copy(value), expiresAt: this.#now() + ttlMs });
    return true;
  }

  async delete(key: string): Promise<void> {
    assertCacheKey(key);
    this.#enter('delete');
    this.entries.delete(this.#prefix + key);
  }

  namespace(name: string): MapCacheStore {
    assertCacheNamespace(name);
    if (this.#closed) throw new CacheErrors.Error('closed', { store: 'cache' });
    let child = this.#children.get(name);
    if (child === undefined) {
      child = new MapCacheStore(this.#now, {
        entries: this.entries,
        calls: this.calls,
        prefix: `${this.#prefix}${name}:`,
      });
      this.#children.set(name, child);
    }
    return child;
  }

  /** A namespace view shares its name with every consumer, so only the root stops. */
  async close(): Promise<void> {
    if (this.#prefix === '') this.#stop();
  }

  #stop(): void {
    this.#closed = true;
    for (const child of this.#children.values()) child.#stop();
  }
}

/** `store` as the `cacheToken` service: every namespace is `store` itself. */
export function cacheServiceOf(store: CacheStore): CacheService {
  return { cache: () => store };
}

/** A Map-backed lease store that counts its calls. */
export class MapLeaseStore implements LeaseStore {
  readonly #now: () => number;
  readonly #held = new Map<string, { token: string; fence: number; expiresAt: number }>();
  #fence = 0;
  #closed = false;
  /** Every operation, in order. */
  readonly calls: string[] = [];
  /** When set, every operation rejects with this error. */
  failWith: Error | undefined;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  #enter(operation: string): void {
    this.calls.push(operation);
    if (this.#closed) throw new CacheErrors.Error('closed', { store: 'lease' });
    if (this.failWith !== undefined) throw this.failWith;
  }

  /** Whether a live lease holds `key`. */
  isHeld(key: string): boolean {
    const held = this.#held.get(key);
    return held !== undefined && this.#now() < held.expiresAt;
  }

  async acquire(key: string, ttlMs: number): Promise<Lease | null> {
    assertCacheKey(key);
    assertTtlMs(ttlMs);
    this.#enter('acquire');
    if (this.isHeld(key)) return null;
    this.#fence += 1;
    const token = randomUUID();
    this.#held.set(key, { token, fence: this.#fence, expiresAt: this.#now() + ttlMs });
    return Object.freeze({ key, token, fence: this.#fence });
  }

  #owned(lease: Lease): { token: string; fence: number; expiresAt: number } | undefined {
    const held = this.#held.get(lease.key);
    if (held === undefined || held.token !== lease.token || held.fence !== lease.fence) {
      return undefined;
    }
    return this.#now() < held.expiresAt ? held : undefined;
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    assertLease(lease);
    assertTtlMs(ttlMs);
    this.#enter('renew');
    const held = this.#owned(lease);
    if (held === undefined) return false;
    held.expiresAt = this.#now() + ttlMs;
    return true;
  }

  async release(lease: Lease): Promise<boolean> {
    assertLease(lease);
    this.#enter('release');
    if (this.#owned(lease) === undefined) return false;
    this.#held.delete(lease.key);
    return true;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
