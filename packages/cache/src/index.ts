/**
 * Cache implementation surface (`@jsails/cache`): the in-memory and Valkey
 * cache and mutex stores, the fixed-window rate limiter, the `cache` plugin,
 * and the API-facing `throttle` helper.
 *
 * The contract (`CacheStore`, `MutexStore`, `cacheToken`, `mutexToken`, and
 * the error classes) lives in core so consumers can depend on it without the
 * implementations; it is re-exported here so `@jsails/cache` is a single
 * import for every cache concern.
 */

export {
  CacheError,
  MutexError,
  cacheToken,
  isMutexStore,
  mutexToken,
  type CacheStore,
  type MutexStore,
} from 'jsails/cache';

export {
  MemoryCacheStore,
  ValkeyCacheStore,
  type MemoryCacheStoreOptions,
  type ValkeyCacheStoreOptions,
} from './cache-store.js';

export {
  MemoryMutexStore,
  ValkeyMutexStore,
  type MemoryMutexStoreOptions,
  type ValkeyMutexStoreOptions,
} from './mutex-store.js';

export {
  FixedWindowRateLimiter,
  guardRateLimit,
  rateLimitResponse,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
} from './rate-limiter.js';

export { cachePlugin, type CacheMutexOptions, type CachePluginOptions } from './plugin.js';

export { throttle, type ThrottleDecision, type ThrottleOptions } from './throttle.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { cachePlugin as default } from './plugin.js';
