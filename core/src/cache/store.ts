/**
 * Cache store contract (`jsails/cache`): an evictable, TTL-bounded key-value
 * store of strings and bytes, with namespaced views.
 *
 * A cache entry may disappear at any moment before its TTL (memory pressure,
 * a restart, an eviction policy), so nothing whose loss breaks correctness
 * belongs in one: locks go to a {@link import('./lease.js').LeaseStore} and
 * rate-limit state to the security cluster's limiter store. The contract has
 * no optional members and no counter, so every implementation offers exactly
 * the same guarantees and a caller never degrades silently.
 *
 * Implementations (the in-memory and Valkey stores) live in `@jsails/cache`;
 * the plugin that provides {@link CacheService} under `cacheToken` lives there
 * too. Core keeps the contract and its argument checks, so every
 * implementation validates keys and TTLs the same way.
 */

import { invariant } from '../errors/registry.js';
import { CacheErrors } from './cache-errors.js';

/**
 * What a cache entry holds. A string reads back as a string and bytes read
 * back as a `Uint8Array` (a copy: mutating it never changes the entry).
 *
 * @public
 */
export type CacheValue = string | Uint8Array;

/**
 * An evictable cache. Every method validates its arguments and rejects with a
 * value-free `CacheErrors` code; a backend failure rejects `unavailable`, and
 * any call after `close` rejects `closed`.
 *
 * @public
 */
export interface CacheStore {
  /** The entry under `key`, or `null` when it is absent, expired, or evicted. */
  get(key: string): Promise<CacheValue | null>;
  /** {@link get} for several keys in one round trip; results follow `keys`' order. */
  getMany(keys: readonly string[]): Promise<(CacheValue | null)[]>;
  /** Store `value` under `key` for `ttlMs` milliseconds, replacing any entry. */
  set(key: string, value: CacheValue, ttlMs: number): Promise<void>;
  /**
   * Store `value` under `key` for `ttlMs` only when no live entry holds the
   * key, atomically. Resolves `true` when this call stored it and `false`
   * when another entry was there (and is left unchanged).
   */
  add(key: string, value: CacheValue, ttlMs: number): Promise<boolean>;
  /** Remove the entry under `key`; a no-op when it is absent. */
  delete(key: string): Promise<void>;
  /**
   * A view whose keys live under `<name>:` of this store's keyspace. Sibling
   * namespaces never share a key; the same `name` always returns the same view
   * object, so one view is shared by every consumer that asks for its name
   * and owns no resource of its own. Its `close` is therefore a no-op: one
   * consumer closing it must not stop it for the others.
   */
  namespace(name: string): CacheStore;
  /**
   * Stop this store and every view of it; later calls reject `closed`.
   * Idempotent, and a no-op on a namespace view (see {@link namespace}).
   */
  close(): Promise<void>;
}

/**
 * The longest TTL a cache entry or a lease may have: 365 days. Longer-lived
 * state is not a cache entry.
 *
 * @public
 */
export const MAX_CACHE_TTL_MS = 31_536_000_000;

/**
 * The longest cache or lease key, in UTF-16 code units.
 *
 * @public
 */
export const MAX_CACHE_KEY_LENGTH = 1024;

const NAMESPACE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Throw `cache.invalid_ttl` unless `ttlMs` is a whole number of milliseconds
 * from 1 to {@link MAX_CACHE_TTL_MS}. Every store, and every caller that computes a
 * TTL, checks through this one function, so a fractional or unbounded TTL never
 * reaches a backend (Valkey's `PX` refuses a fraction).
 *
 * @public
 */
export function assertTtlMs(ttlMs: unknown): asserts ttlMs is number {
  invariant(
    typeof ttlMs === 'number' &&
      Number.isSafeInteger(ttlMs) &&
      ttlMs >= 1 &&
      ttlMs <= MAX_CACHE_TTL_MS,
    CacheErrors,
    'invalid_ttl',
  );
}

/**
 * Throw `cache.invalid_key` unless `key` is a non-empty string of at most
 * {@link MAX_CACHE_KEY_LENGTH} code units.
 *
 * @public
 */
export function assertCacheKey(key: unknown): asserts key is string {
  invariant(
    typeof key === 'string' && key.length > 0 && key.length <= MAX_CACHE_KEY_LENGTH,
    CacheErrors,
    'invalid_key',
  );
}

/**
 * Throw `cache.invalid_value` unless `value` is a string or a `Uint8Array`.
 *
 * @public
 */
export function assertCacheValue(value: unknown): asserts value is CacheValue {
  invariant(typeof value === 'string' || value instanceof Uint8Array, CacheErrors, 'invalid_value');
}

/**
 * Throw `cache.invalid_namespace` unless `name` is 1 to 64 letters, digits,
 * `.`, `_` or `-`. A `:` is refused so that two sibling namespaces can never
 * address the same key.
 *
 * @public
 */
export function assertCacheNamespace(name: unknown): asserts name is string {
  invariant(typeof name === 'string' && NAMESPACE.test(name), CacheErrors, 'invalid_namespace');
}
