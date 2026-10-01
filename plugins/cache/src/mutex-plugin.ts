/**
 * First-party `mutex` plugin: exposes an application {@link MutexStore} under a
 * typed service token, owned and torn down by the plugin.
 *
 * `mutexPlugin({ store?|valkeyUrl?|prefix?|onError? })` builds a
 * {@link JsailsPlugin} named `mutex` whose `setup` provides the store under
 * the core {@link import('jsails/cache').mutexToken}:
 *
 * - with an explicit `store`, that store is used verbatim (identity preserved)
 *   and the plugin never closes it;
 * - otherwise the plugin owns the store: a Valkey-backed store when a URL is
 *   configured (`valkeyUrl`, else `VALKEY_URL`), and the
 *   in-memory store as the zero-config default.
 *
 * Construction is lazy: nothing connects and no URL is validated at import,
 * plugin construction, or `setup`. The Valkey store resolves and validates its
 * URL and opens its connection on the first operation only. The cleanup closes
 * only the store the plugin created, and is a no-op when a caller's store was
 * provided (or a plugin-owned store was never used).
 */

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { isMutexStore, mutexToken, type MutexStore } from 'jsails/cache';
import { DEFAULT_MUTEX_PREFIX, MemoryMutexStore, ValkeyMutexStore } from './mutex.js';
import { resolveValkeyUrl } from './valkey-connection.js';

/** Options accepted by {@link mutexPlugin}. */
export interface MutexPluginOptions {
  /** Caller-provided store; used verbatim and never closed by the plugin. */
  readonly store?: MutexStore;
  /** Valkey/Redis URL. */
  readonly valkeyUrl?: string;
  /** Key prefix for the Valkey-backed store. Defaults to {@link DEFAULT_MUTEX_PREFIX}. */
  readonly prefix?: string;
  /** Error callback for the Valkey store's post-connect failures. */
  readonly onError?: (error: Error) => void;
}

/**
 * Build the first-party `mutex` plugin. Nothing is constructed or connected at
 * plugin construction; the store is selected during `setup` (cheap, no
 * connection) and any Valkey connection opens lazily on first use.
 */
export function mutexPlugin(options: MutexPluginOptions = {}): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('mutexPlugin requires an options object');
  }
  if (options.store !== undefined && !isMutexStore(options.store)) {
    throw new TypeError('store must be a mutex store');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }

  return definePlugin({
    name: 'mutex',
    setup({ services }) {
      const owned = options.store === undefined;
      const store = options.store ?? buildOwnedStore(options);
      services.provide(mutexToken, store);

      return async () => {
        if (owned) {
          await store.close();
        }
      };
    },
  });
}

/** Select the plugin-owned store: Valkey when a URL is configured, else memory. */
function buildOwnedStore(options: MutexPluginOptions): MutexStore {
  const url = resolveValkeyUrl(options);
  if (url === undefined) {
    return new MemoryMutexStore();
  }
  return new ValkeyMutexStore({
    valkeyUrl: url,
    prefix: options.prefix ?? DEFAULT_MUTEX_PREFIX,
    onError: options.onError,
  });
}
