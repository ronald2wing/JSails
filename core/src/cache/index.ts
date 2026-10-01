/**
 * Cache and lease contracts (`jsails/cache`): the evictable {@link CacheStore}
 * with namespaced views, the fenced {@link LeaseStore} and the
 * {@link withLease} hold loop, {@link defineCache} over the app's
 * {@link CacheTags} tag token table, the shared key, TTL and tag checks, the
 * `cache.*` error registry, and the `cache`/`cache.tags`/`lease` service
 * tokens.
 *
 * Implementations (the in-memory and Valkey stores, the Valkey tag bus) and
 * the `cache` plugin live in `@jsails/cache`.
 */

export { CacheErrors } from './cache-errors.js';

export {
  MAX_CACHE_KEY_LENGTH,
  MAX_CACHE_TTL_MS,
  assertCacheKey,
  assertCacheNamespace,
  assertCacheValue,
  assertTtlMs,
  type CacheStore,
  type CacheValue,
} from './store.js';

export {
  assertLease,
  isLeaseStore,
  withLease,
  type Lease,
  type LeaseOutcome,
  type LeaseStore,
  type WithLeaseOptions,
} from './lease.js';

export {
  createCacheTags,
  type CacheTagBus,
  type CacheTagBusHandlers,
  type CacheTags,
  type CacheTagsOptions,
} from './tag-tokens.js';

export {
  createCacheSlot,
  defineCache,
  type Cache,
  type CacheCodec,
  type CacheDefinition,
  type CacheLoader,
  type CacheServices,
  type CacheSlot,
  type CacheStampede,
  type CacheStats,
  type CacheTier,
} from './define-cache.js';

export {
  cacheStoreToken,
  cacheTagsToken,
  cacheToken,
  leaseToken,
  type CacheService,
} from './tokens.js';
