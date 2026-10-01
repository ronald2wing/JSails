/**
 * Cache, tag token, and lease service tokens (`jsails/cache`).
 *
 * The tokens are core-owned so consumers can resolve the services without
 * importing the implementation package. The plugin that provides them lives in
 * `@jsails/cache`.
 */

import {
  createServiceToken,
  type ServiceToken,
  type ServiceTokenFamily,
} from '../extensions/services.js';
import type { LeaseStore } from './lease.js';
import type { CacheStore } from './store.js';
import type { CacheTags } from './tag-tokens.js';

/**
 * The application cache as a service. Every consumer takes its own namespace,
 * so no plugin reads or clears another's entries and the un-namespaced store
 * is reachable by nobody.
 *
 * @public
 */
export interface CacheService {
  /**
   * The namespace `name` of the application cache (see
   * {@link CacheStore.namespace}); the same name returns the same store.
   */
  cache(name: string): CacheStore;
}

/**
 * Token for the application {@link CacheService}, provided by `cachePlugin`
 * in `@jsails/cache`.
 *
 * @public
 */
export const cacheToken: ServiceToken<CacheService> = createServiceToken<CacheService>('cache');

/**
 * Token for the application {@link LeaseStore}, provided by
 * `cachePlugin({ leases })` in `@jsails/cache`.
 *
 * @public
 */
export const leaseToken: ServiceToken<LeaseStore> = createServiceToken<LeaseStore>('lease');

/**
 * Token for the application's {@link CacheTags} table, provided by
 * `cachePlugin` in `@jsails/cache` next to `cacheToken`. Every defined cache
 * of the app shares it, so invalidating a tag reaches all of them.
 *
 * @public
 */
export const cacheTagsToken: ServiceToken<CacheTags> = createServiceToken<CacheTags>('cache.tags');

/**
 * Token family for a root {@link CacheStore} another plugin provides, named
 * by `cachePlugin({ store: cacheStoreToken })` (or a keyed member) so the
 * application cache is built on that store. The cache plugin never closes it.
 *
 * @public
 */
export const cacheStoreToken: ServiceTokenFamily<CacheStore> =
  createServiceToken<CacheStore>('cache.store');
