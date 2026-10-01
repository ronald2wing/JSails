/**
 * Cache and mutex service tokens (`jsails/cache`).
 *
 * The tokens are core-owned so consumers can resolve the services without
 * importing the implementation package. The plugins that provide the stores
 * under these tokens live in `@jsails/cache`.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { CacheStore } from './store.js';
import type { MutexStore } from './mutex.js';

/**
 * Opaque token for the application {@link CacheStore}. Shared by the provider
 * (`cachePlugin` in `@jsails/cache`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const cacheToken: ServiceToken<CacheStore> = createServiceToken<CacheStore>('cache');

/**
 * Opaque token for the application {@link MutexStore}. Shared by the provider
 * (`mutexPlugin` in `@jsails/cache`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const mutexToken: ServiceToken<MutexStore> = createServiceToken<MutexStore>('mutex');
