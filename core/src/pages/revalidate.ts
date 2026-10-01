/**
 * On-demand revalidation — purge cached pages by path or by tag.
 *
 * The Next.js `revalidatePath` / `revalidateTag` analog, on top of the same
 * cache store the page `revalidate` (ISR) path uses. A page that opts into
 * caching may also declare `tags: string[]`; when its props are cached, the
 * cache key is recorded in a reverse index (path → keys, tag → keys). The index
 * is keyed **per cache store** (a `WeakMap`), so two apps / two stores never
 * share or leak invalidation state — matching the framework's no-global-registry
 * discipline.
 *
 * `revalidatePath` / `revalidateTag` delete every recorded key through the same
 * store. Revalidation is graceful-degradation: a purge that fails falls back to
 * TTL expiry, never throws to the caller.
 */

import type { ServiceRegistry } from '../extensions/services.js';
import { tryResolveCacheStore } from './cache-resolver.js';
import { normalizeUrlPath } from '../internal/paths.js';
import type { CacheStore } from '../cache/store.js';

// ---------------------------------------------------------------------------
// Reverse index (per store)
// ---------------------------------------------------------------------------

/** Default cap on keys tracked by one {@link RevalidationIndex}. */
const DEFAULT_MAX_INDEXED_KEYS = 10_000;

/**
 * Reverse index from path/tag to cache keys.
 *
 * The index is bounded in two ways, because a cache key is recorded on every
 * cache miss and a page with a query-string key can mint unbounded distinct
 * keys. Each entry carries the cache entry's expiry, so a key whose cache
 * entry has already expired is dropped instead of being "deleted" later; and
 * the total number of tracked keys is capped, evicting the oldest insertions.
 */
class RevalidationIndex {
  readonly #paths = new Map<string, Set<string>>();
  readonly #tags = new Map<string, Set<string>>();
  /** Insertion-ordered key -> expiry (epoch ms); `Infinity` when no TTL. */
  readonly #expiry = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  record(key: string, path: string, tags: readonly string[], ttlMs?: number): void {
    this.#expiry.delete(key);
    this.#expiry.set(key, ttlMs === undefined ? Number.POSITIVE_INFINITY : this.#now() + ttlMs);
    this.#recordPath(key, path);
    for (const tag of tags) {
      this.#recordTag(key, tag);
    }
    this.#enforceCap();
  }

  keysForPath(path: string): string[] {
    return this.#liveKeys(this.#paths.get(path));
  }

  keysForTag(tag: string): string[] {
    return this.#liveKeys(this.#tags.get(tag));
  }

  removeKey(key: string): void {
    this.#expiry.delete(key);
    for (const keys of this.#paths.values()) keys.delete(key);
    for (const keys of this.#tags.values()) keys.delete(key);
  }

  /** Keys in `set` whose cache entry has not expired, pruning dead ones. */
  #liveKeys(set: Set<string> | undefined): string[] {
    if (set === undefined) return [];
    const now = this.#now();
    const live: string[] = [];
    for (const key of set) {
      const expiresAt = this.#expiry.get(key);
      if (expiresAt === undefined || now >= expiresAt) {
        set.delete(key);
        this.#expiry.delete(key);
        continue;
      }
      live.push(key);
    }
    return live;
  }

  #recordPath(key: string, path: string): void {
    const keys = this.#paths.get(path) ?? new Set<string>();
    keys.add(key);
    this.#paths.set(path, keys);
  }

  #recordTag(key: string, tag: string): void {
    const keys = this.#tags.get(tag) ?? new Set<string>();
    keys.add(key);
    this.#tags.set(tag, keys);
  }

  /** Drop the oldest tracked keys once the cap is exceeded. */
  #enforceCap(): void {
    if (this.#expiry.size <= DEFAULT_MAX_INDEXED_KEYS) {
      return;
    }
    for (const key of this.#expiry.keys()) {
      if (this.#expiry.size <= DEFAULT_MAX_INDEXED_KEYS) {
        break;
      }
      this.removeKey(key);
    }
  }
}

/** Reverse indexes, keyed by cache-store identity (never a global singleton). */
const indexes = new WeakMap<CacheStore, RevalidationIndex>();

function indexFor(store: CacheStore): RevalidationIndex {
  const existing = indexes.get(store);
  if (existing !== undefined) return existing;
  const created = new RevalidationIndex(() => Date.now());
  indexes.set(store, created);
  return created;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** A minimal carrier of the request context needed to resolve the cache store. */
export interface RevalidationContext {
  readonly services?: Pick<ServiceRegistry, 'tryGet'>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a cache key under its route path and tags. Called by the page cache
 * writer with the same store instance it caches through.
 */
export function recordPageCacheKey(
  store: CacheStore,
  key: string,
  path: string,
  tags: readonly string[],
  ttlMs?: number,
): void {
  indexFor(store).record(key, normalizeUrlPath(path), tags, ttlMs);
}

/** Options for {@link revalidatePath}. */
export interface RevalidatePathOptions {
  /** Reserved for future layout-scoped invalidation; treated as a page purge. */
  readonly type?: 'page' | 'layout';
}

/**
 * Invalidate every cached page recorded under `path`. Resolves the cache store
 * lazily from the context; without a store this is a silent no-op.
 */
export async function revalidatePath(
  path: string,
  options: RevalidatePathOptions = {},
  context?: RevalidationContext,
): Promise<void> {
  void options;
  const store = tryResolveCacheStore(context?.services);
  if (store === undefined) return;

  const index = indexFor(store);
  for (const key of index.keysForPath(normalizeUrlPath(path))) {
    try {
      await store.delete(key);
    } catch {
      // Fall back to TTL expiry; revalidation is never a source of errors.
    }
    index.removeKey(key);
  }
}

/** Invalidate every cached page recorded under `tag`. */
export async function revalidateTag(tag: string, context?: RevalidationContext): Promise<void> {
  if (typeof tag !== 'string' || tag.trim() === '' || tag.includes('\0')) {
    return; // Value-free: an invalid tag purges nothing rather than throwing.
  }
  const store = tryResolveCacheStore(context?.services);
  if (store === undefined) return;

  const index = indexFor(store);
  for (const key of index.keysForTag(tag)) {
    try {
      await store.delete(key);
    } catch {
      // Fall back to TTL expiry.
    }
    index.removeKey(key);
  }
}

/** Resolve the cache store from an optional context, failing closed to undefined. */
