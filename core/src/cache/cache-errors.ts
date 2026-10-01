/**
 * The cache error codes, `cache.*`: every failure a {@link CacheStore}, a
 * {@link LeaseStore}, a defined cache and its tag tokens, or their
 * implementations raise. Messages carry no key, value, namespace, tag, token,
 * or backend detail; a backend failure keeps the original error as `cause`
 * for the operator.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

const CACHE_ERRORS = {
  invalid_key: {
    kind: 'invalid',
    message: 'a cache or lease key is a non-empty string of at most 1024 characters',
  },
  invalid_ttl: {
    kind: 'invalid',
    message: 'a cache or lease TTL is a whole number of milliseconds from 1 to one year',
  },
  invalid_value: {
    kind: 'invalid',
    message: 'a cache value is a string or a Uint8Array',
  },
  invalid_namespace: {
    kind: 'invalid',
    message: 'a cache namespace is 1 to 64 letters, digits, ".", "_" or "-"',
  },
  invalid_lease: {
    kind: 'invalid',
    message: 'the value is not a lease this store issued',
  },
  invalid_option: {
    kind: 'internal',
    message: 'cache option {option} is invalid',
    context: { option: 'identifier' },
  },
  invalid_tag: {
    kind: 'invalid',
    message: 'a cache tag is 1 to 128 letters, digits, "_", "@", ".", ":", "/" or "-"',
  },
  too_many_tags: {
    kind: 'invalid',
    message: 'a cache entry carries at most 32 tags',
  },
  duplicate_cache: {
    kind: 'internal',
    message: 'a cache named {name} is already defined in this application',
    context: { name: 'identifier' },
  },
  too_large: {
    kind: 'too_large',
    message: 'the cache entry is larger than the store byte budget',
  },
  unavailable: {
    kind: 'unavailable',
    message: 'the {store} backend is unavailable',
    context: { store: ['cache', 'lease', 'rate_limit'] },
  },
  closed: {
    kind: 'unavailable',
    message: 'the {store} store is closed',
    context: { store: ['cache', 'lease', 'rate_limit'] },
  },
} as const;

/**
 * The cache registry. Recognize a code with `CacheErrors.is(error, 'closed')`;
 * raise one with `new CacheErrors.Error('unavailable', { store: 'cache' }, { cause })`.
 *
 * @public
 */
export const CacheErrors: ErrorRegistry<'cache', typeof CACHE_ERRORS> = defineErrors(
  'cache',
  CACHE_ERRORS,
);
