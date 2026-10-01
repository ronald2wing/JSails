/**
 * The in-memory {@link LeaseStore}: leases in their own map, never shared with
 * cache entries and never evicted while live.
 *
 * Expired leases are swept on `acquire`, through a lazy expiry heap, so the
 * map holds at most the live leases plus those that expired since the last
 * acquisition. The fence is one counter for the whole store, so it grows with
 * every acquisition of any key. Exclusion holds within one process only: a
 * deployment with several processes uses {@link ValkeyLeaseStore}.
 */

import { randomBytes } from 'node:crypto';

import {
  CacheErrors,
  assertCacheKey,
  assertLease,
  assertTtlMs,
  type Lease,
  type LeaseStore,
} from 'jsails/cache';

import { ExpiryHeap } from './expiry-heap.js';

/**
 * Options for {@link MemoryLeaseStore}.
 *
 * @public
 */
export interface MemoryLeaseStoreOptions {
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface Held {
  readonly token: string;
  readonly fence: number;
  expiresAt: number;
}

/** A fresh, unguessable owner token. */
export function newLeaseToken(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * In-memory lease store. Construct with `new MemoryLeaseStore({ now? })`; it
 * holds no external resource.
 *
 * @public
 */
export class MemoryLeaseStore implements LeaseStore {
  readonly #now: () => number;
  readonly #held = new Map<string, Held>();
  readonly #expiries = new ExpiryHeap();
  #fence = 0;
  #closed = false;

  constructor(options: MemoryLeaseStoreOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new CacheErrors.Error('invalid_option', { option: 'MemoryLeaseStore' });
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new CacheErrors.Error('invalid_option', { option: 'now' });
    }
    this.#now = options.now ?? (() => Date.now());
  }

  async acquire(key: string, ttlMs: number): Promise<Lease | null> {
    assertCacheKey(key);
    assertTtlMs(ttlMs);
    this.#assertOpen();
    const now = this.#now();
    this.#sweep(now);
    const current = this.#held.get(key);
    if (current !== undefined && now < current.expiresAt) return null;
    this.#fence += 1;
    const held: Held = { token: newLeaseToken(), fence: this.#fence, expiresAt: now + ttlMs };
    this.#held.set(key, held);
    this.#expiries.push(held.expiresAt, key);
    return Object.freeze({ key, token: held.token, fence: held.fence });
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    assertLease(lease);
    assertTtlMs(ttlMs);
    this.#assertOpen();
    const now = this.#now();
    const held = this.#owned(lease, now);
    if (held === undefined) return false;
    held.expiresAt = now + ttlMs;
    this.#expiries.push(held.expiresAt, lease.key);
    return true;
  }

  async release(lease: Lease): Promise<boolean> {
    assertLease(lease);
    this.#assertOpen();
    if (this.#owned(lease, this.#now()) === undefined) return false;
    this.#held.delete(lease.key);
    return true;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#held.clear();
    this.#expiries.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new CacheErrors.Error('closed', { store: 'lease' });
  }

  /** The live entry `lease` still owns. */
  #owned(lease: Lease, now: number): Held | undefined {
    const held = this.#held.get(lease.key);
    if (
      held === undefined ||
      held.token !== lease.token ||
      held.fence !== lease.fence ||
      now >= held.expiresAt
    ) {
      return undefined;
    }
    return held;
  }

  #sweep(now: number): void {
    this.#expiries.drain(now, (key) => {
      const held = this.#held.get(key);
      if (held !== undefined && held.expiresAt <= now) this.#held.delete(key);
    });
    this.#expiries.compact(this.#held.size, () => this.#pairs());
  }

  *#pairs(): Iterable<readonly [string, number]> {
    for (const [key, held] of this.#held) yield [key, held.expiresAt];
  }
}
