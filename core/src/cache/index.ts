/**
 * Cache contract (`jsails/cache`): the string-keyed {@link CacheStore} surface,
 * the atomic {@link MutexStore} surface, the value-free error classes, and the
 * `cache`/`mutex` service tokens.
 *
 * Implementations (the in-memory and Valkey/Redis stores), the fixed-window
 * rate limiter, the `cache`/`mutex` plugins, and the API-facing `throttle`
 * helper live in `@jsails/cache`.
 */

export { CacheError, type CacheStore } from './store.js';

export { MutexError, isMutexStore, type MutexStore } from './mutex.js';

export { cacheToken, mutexToken } from './tokens.js';
