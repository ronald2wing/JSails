/**
 * Resolve the page cache, the `pages` namespace of the application cache, from
 * a request/service registry.
 *
 * A page render must never fail because cache resolution failed: an absent
 * registry, an absent provider, a closed cache, or a throwing `tryGet`
 * degrades to no cache.
 */

import { cacheToken } from '../cache/tokens.js';
import type { CacheStore } from '../cache/store.js';
import type { ServiceRegistry } from '../extensions/services.js';

/** The application cache namespace the page cache and its revalidation use. */
const PAGE_CACHE_NAMESPACE = 'pages';

/** Resolve the page cache store, or `undefined` when it is unavailable. */
export function tryResolveCacheStore(
  services: Pick<ServiceRegistry, 'tryGet'> | undefined,
): CacheStore | undefined {
  try {
    return services?.tryGet(cacheToken)?.cache(PAGE_CACHE_NAMESPACE);
  } catch {
    return undefined;
  }
}
