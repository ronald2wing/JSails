/**
 * A Map-backed cache store for the webhook tests, which do not depend on
 * `@jsails/cache`: entries expire by their TTL against a clock the test moves,
 * `add` is atomic (one synchronous check-and-store), and every `add` is
 * counted so a test can see whether a replay slot was consumed.
 */

import type { CacheStore, CacheValue } from 'jsails/cache';

/** The store, its clock, and what it recorded. */
export interface ClaimStore extends CacheStore {
  /** Every `add`, in order: the key and the TTL it asked for. */
  readonly adds: { readonly key: string; readonly ttlMs: number }[];
  /** Move the store's clock forward. */
  advance(ms: number): void;
  /** Whether `key` holds a live entry. */
  has(key: string): boolean;
}

export function claimStore(): ClaimStore {
  let now = 0;
  const entries = new Map<string, { value: CacheValue; expiresAt: number }>();
  const adds: { key: string; ttlMs: number }[] = [];
  const live = (key: string): CacheValue | null => {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (now >= entry.expiresAt) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  };
  const store: ClaimStore = {
    adds,
    advance: (ms) => {
      now += ms;
    },
    has: (key) => live(key) !== null,
    get: async (key) => live(key),
    getMany: async (keys) => keys.map(live),
    set: async (key, value, ttlMs) => {
      entries.set(key, { value, expiresAt: now + ttlMs });
    },
    add: async (key, value, ttlMs) => {
      adds.push({ key, ttlMs });
      if (live(key) !== null) return false;
      entries.set(key, { value, expiresAt: now + ttlMs });
      return true;
    },
    delete: async (key) => {
      entries.delete(key);
    },
    namespace: () => store,
    close: async () => undefined,
  };
  return store;
}
