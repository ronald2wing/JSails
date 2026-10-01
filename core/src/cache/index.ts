/**
 * Cache contract (`jsails/cache`): the string-keyed {@link CacheStore} surface,
 * the atomic {@link MutexStore} surface, the value-free error classes, and the
 * `cache`/`mutex` service tokens.
 *
 * Implementations (the in-memory and Valkey stores), the fixed-window
 * rate limiter, the `cache`/`mutex` plugins, and the API-facing `throttle`
 * helper live in `@jsails/cache`.
 */

export { CacheError, type CacheErrorCode, type CacheStore } from './store.js';

export { MutexError, isMutexStore, type MutexErrorCode, type MutexStore } from './mutex.js';

export { cacheToken, mutexToken } from './tokens.js';
