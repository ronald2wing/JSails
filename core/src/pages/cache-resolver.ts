/**
 * Resolve the application cache store from a request/service registry.
 *
 * A page render must never fail because cache resolution failed: an absent
 * registry, an absent provider, or a throwing `tryGet` degrades to no cache.
 */

import { cacheToken } from '../cache/tokens.js';
import type { CacheStore } from '../cache/store.js';
import type { ServiceRegistry } from '../extensions/services.js';

/** Resolve the cache store, or `undefined` when it is unavailable. */
export function tryResolveCacheStore(
  services: Pick<ServiceRegistry, 'tryGet'> | undefined,
): CacheStore | undefined {
  try {
    return services?.tryGet(cacheToken);
  } catch {
    return undefined;
  }
}
