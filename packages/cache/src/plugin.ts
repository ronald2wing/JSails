/**
 * First-party `cache` plugin: exposes an application {@link CacheStore} under
 * `cacheToken` and, when asked, a {@link MutexStore} under `mutexToken`. Both
 * live in one plugin because they share the same backend selection (Valkey
 * when a URL is configured, else in-memory) and a declarative `plugins.use`
 * entry can only name one default export per package.
 *
 * For each store:
 *
 * - an explicit `store` is used verbatim (identity preserved) and the plugin
 *   never closes it;
 * - otherwise the plugin owns the store: a Valkey-backed store when a URL is
 *   configured (`valkeyUrl`, else `VALKEY_URL`), and the in-memory store as
 *   the zero-config default.
 *
 * The mutex is opt-in (`mutex: true` or `mutex: { store?, prefix? }`) because
 * the in-memory default only excludes work within one process; an app that
 * asks for it has decided that is acceptable or has configured Valkey.
 *
 * Construction is lazy: nothing connects and no URL is validated at import,
 * plugin construction, or `setup`. Valkey stores resolve and validate their
 * URL and open their connection on the first operation only. The cleanup
 * closes only the stores the plugin created.
 */

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import {
  cacheToken,
  isMutexStore,
  mutexToken,
  type CacheStore,
  type MutexStore,
} from 'jsails/cache';
import { resolveValkeyUrl } from 'jsails/plugin-sdk';
import { MemoryCacheStore, ValkeyCacheStore } from './cache-store.js';
import { MemoryMutexStore, ValkeyMutexStore } from './mutex-store.js';

/** Mutex settings accepted by {@link CachePluginOptions.mutex}. */
export interface CacheMutexOptions {
  /** Caller-provided mutex store; used verbatim and never closed by the plugin. */
  readonly store?: MutexStore;
  /** Key prefix for the Valkey-backed mutex. Defaults to `jsails:mutex`. */
  readonly prefix?: string;
}

/** Options accepted by {@link cachePlugin}. */
export interface CachePluginOptions {
  /** Caller-provided cache store; used verbatim and never closed by the plugin. */
  readonly store?: CacheStore;
  /** Valkey URL shared by the owned cache and mutex stores. */
  readonly valkeyUrl?: string;
  /** Key prefix for the Valkey-backed cache. Defaults to `jsails:cache`. */
  readonly prefix?: string;
  /** Error callback for the owned Valkey stores' post-connect failures. */
  readonly onError?: (error: Error) => void;
  /** Also provide a mutex store under `mutexToken`. Off by default. */
  readonly mutex?: boolean | CacheMutexOptions;
}

/**
 * Create the first-party `cache` plugin. Nothing is constructed or connected
 * at plugin construction; stores are selected during `setup` (cheap, no
 * connection) and any Valkey connection opens lazily on first use.
 */
export function cachePlugin(options: CachePluginOptions = {}): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('cachePlugin requires an options object');
  }
  if (
    options.store !== undefined &&
    (options.store === null ||
      typeof options.store !== 'object' ||
      typeof options.store.get !== 'function')
  ) {
    throw new TypeError('store must be a cache store');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  const mutex = readMutexOptions(options.mutex);

  return definePlugin({
    name: 'cache',
    setup({ services }) {
      const owned: { close(): Promise<void> }[] = [];

      const cache = options.store ?? createOwnedCache(options);
      if (options.store === undefined) owned.push(cache);
      services.provide(cacheToken, cache);

      if (mutex !== undefined) {
        const store = mutex.store ?? createOwnedMutex(options, mutex);
        if (mutex.store === undefined) owned.push(store);
        services.provide(mutexToken, store);
      }

      return async () => {
        await Promise.all(owned.map((store) => store.close()));
      };
    },
  });
}

function readMutexOptions(value: CachePluginOptions['mutex']): CacheMutexOptions | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('mutex must be a boolean or an options object');
  }
  if (value.store !== undefined && !isMutexStore(value.store)) {
    throw new TypeError('mutex.store must be a mutex store');
  }
  return value;
}

function createOwnedCache(options: CachePluginOptions): CacheStore {
  const url = resolveValkeyUrl(options);
  if (url === undefined) {
    return new MemoryCacheStore();
  }
  return new ValkeyCacheStore({ valkeyUrl: url, prefix: options.prefix, onError: options.onError });
}

function createOwnedMutex(options: CachePluginOptions, mutex: CacheMutexOptions): MutexStore {
  const url = resolveValkeyUrl(options);
  if (url === undefined) {
    return new MemoryMutexStore();
  }
  return new ValkeyMutexStore({ valkeyUrl: url, prefix: mutex.prefix, onError: options.onError });
}
