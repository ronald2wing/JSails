/**
 * Cache implementation surface (`@jsails/cache`): the in-memory and Valkey
 * cache and lease stores, the Valkey tag bus, the `cache` plugin, and the
 * fixed-window rate limiter with its `throttle` helper.
 *
 * The contracts (`CacheStore`, `LeaseStore`, `withLease`, `defineCache` and
 * its tag tokens, the tokens, and the `cache.*` error registry) live in
 * `jsails/cache` so consumers can depend on them without the implementations;
 * the most used are re-exported here so `@jsails/cache` is a single import
 * for every cache concern.
 */

export {
  CacheErrors,
  cacheTagsToken,
  cacheToken,
  defineCache,
  leaseToken,
  withLease,
  type Cache,
  type CacheDefinition,
  type CacheService,
  type CacheStore,
  type CacheValue,
  type Lease,
  type LeaseStore,
} from 'jsails/cache';

export {
  MemoryCacheStore,
  type MemoryCacheStoreOptions,
  type MemoryCacheUsage,
} from './memory-cache-store.js';

export { ValkeyCacheStore, type ValkeyCacheStoreOptions } from './valkey-cache-store.js';

export { MemoryLeaseStore, type MemoryLeaseStoreOptions } from './memory-lease-store.js';

export { ValkeyLeaseStore, type ValkeyLeaseStoreOptions } from './valkey-lease-store.js';

export { ValkeyTagBus, type ValkeyTagBusOptions } from './valkey-tag-bus.js';

export {
  FixedWindowRateLimiter,
  guardRateLimit,
  rateLimitResponse,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
} from './rate-limiter.js';

export {
  cachePlugin,
  type CacheLeaseOptions,
  type CachePluginOptions,
  type CacheTagOptions,
} from './plugin.js';

export { throttle, type ThrottleDecision, type ThrottleOptions } from './throttle.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { cachePlugin as default } from './plugin.js';
