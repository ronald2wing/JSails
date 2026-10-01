/**
 * Cache implementation surface (`@jsails/cache`): the in-memory and
 * Valkey/Redis store implementations, the fixed-window rate limiter, the
 * `cache`/`mutex` plugins, and the API-facing `throttle` helper.
 *
 * The core contract (`CacheStore`, `MutexStore`, `cacheToken`, `mutexToken`,
 * and the error classes) lives in `jsails/cache`; this package re-exports it
 * alongside the implementations so `@jsails/cache` is a single import for
 * every cache concern.
 */

// Core contract re-exports (see ./contract.js): the contract lives in
// `jsails/cache` and is re-exported here, following `@jsails/signals`.
export { CacheError, type CacheStore } from './contract.js';

export { MutexError, isMutexStore, type MutexStore } from './contract.js';

export { cacheToken, mutexToken } from './contract.js';

export {
  DEFAULT_CACHE_PREFIX,
  MemoryCacheStore,
  ValkeyCacheStore,
  type MemoryCacheStoreOptions,
  type ValkeyCacheStoreOptions,
} from './store.js';

export {
  DEFAULT_MUTEX_PREFIX,
  MemoryMutexStore,
  ValkeyMutexStore,
  type MemoryMutexStoreOptions,
  type ValkeyMutexStoreOptions,
} from './mutex.js';

export {
  FixedWindowRateLimiter,
  guardRateLimit,
  rateLimitResponse,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
} from './limiter.js';

export { cachePlugin, type CachePluginOptions } from './plugin.js';

export { mutexPlugin, type MutexPluginOptions } from './mutex-plugin.js';

export { throttle, type ThrottleDecision, type ThrottleOptions } from './throttling.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { cachePlugin as default } from './plugin.js';
