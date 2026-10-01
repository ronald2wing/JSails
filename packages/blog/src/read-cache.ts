/**
 * A short-lived, per-repository cache for the small reads the public blog
 * routes make on every request (the active theme setting, the primary menu).
 *
 * Without it each themed page costs extra queries before any content is read.
 * Entries expire after a few seconds so a change written by another process
 * still shows promptly, and a writer in this process (the theme and menu admin
 * pages) drops the entry the moment it saves, so its own change shows on the
 * very next request. The cache is keyed by repository identity, so two apps in
 * one process never share entries.
 */

import type { BlogRepository } from './cms/index.js';

/** How long a cached read stays fresh, in milliseconds. */
export const BLOG_READ_CACHE_TTL_MS = 5_000;

/** The cache key of the primary menu read. */
export const PRIMARY_MENU_CACHE_KEY = 'menu:primary';

/** The cache key of a setting read. */
export function settingCacheKey(key: string): string {
  return `setting:${key}`;
}

/** One cached read: the value and when it goes stale. */
interface CachedRead {
  readonly value: unknown;
  readonly expiresAt: number;
}

const caches = new WeakMap<BlogRepository, Map<string, CachedRead>>();

/**
 * The value of `load()` through the cache. A failed load is not cached, so the
 * next request retries the repository.
 */
export async function readCached<T>(
  repository: BlogRepository,
  key: string,
  load: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  let cache = caches.get(repository);
  const hit = cache?.get(key);
  // The entry under `key` was stored by the loader for the same key.
  if (hit !== undefined && hit.expiresAt > now()) return hit.value as T;
  const value = await load();
  if (cache === undefined) {
    cache = new Map();
    caches.set(repository, cache);
  }
  cache.set(key, { value, expiresAt: now() + BLOG_READ_CACHE_TTL_MS });
  return value;
}

/** Drop a cached read after this process writes the data behind it. */
export function invalidateCached(repository: BlogRepository, key: string): void {
  caches.get(repository)?.delete(key);
}
