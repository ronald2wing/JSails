/**
 * Cache contract re-export (`@jsails/cache`).
 *
 * The contract lives in core (`jsails/cache`) so consumers can depend on the
 * surface without importing the implementation package; this package re-exports
 * it alongside the store implementations, the rate limiter, and the plugins so
 * `@jsails/cache` is a single import for every cache concern.
 */

export { CacheError, type CacheStore } from 'jsails/cache';

export { MutexError, isMutexStore, type MutexStore } from 'jsails/cache';

export { cacheToken, mutexToken } from 'jsails/cache';
