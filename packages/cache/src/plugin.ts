/**
 * First-party `cache` plugin: provides the application {@link CacheService}
 * under `cacheToken`, the application's {@link CacheTags} tag token table
 * under `cacheTagsToken` (what `defineCache` validates entries against), and,
 * when asked, a {@link LeaseStore} under `leaseToken`.
 *
 * `cachePlugin(options?)` configures a plugin named `cache` on the
 * `definePlugin` contract. Its options are data and service tokens, checked
 * by a strict schema when the factory is called (a failure is
 * `config.invalid_options`, before anything runs).
 *
 * The cache service hands every consumer its own namespace of one root store
 * (`services.get(cacheToken).cache('pages')`); the root store itself is
 * reachable through no token, so no plugin can read or clear another's
 * entries. `store` chooses the root:
 *
 * - unset: a {@link ValkeyCacheStore} on the app's Valkey when there is one
 *   (`valkeyToken` from another plugin, else the plugin's own `VALKEY_URL`),
 *   otherwise a {@link MemoryCacheStore} (`maxBytes`, `maxEntries`);
 * - `'memory'` or `'valkey'`: that store, whatever else is configured
 *   (`'valkey'` without a Valkey fails setup);
 * - a `cacheStoreToken` (or a keyed member): the store another plugin
 *   provides under it, required, used verbatim and never closed here.
 *
 * Leases are opt-in (`leases: true` or `leases: { prefix?, url? }`) because
 * the in-memory store excludes only within one process; an app that asks has
 * decided that is acceptable or has Valkey. They never share state with the
 * cache: the in-memory leases are their own structure, and the Valkey leases
 * live under their own prefix, on a second server when `leases.url` is given
 * (one whose `maxmemory-policy` evicts nothing, while the cache server may
 * evict freely). An app with its own lease store provides `leaseToken` from
 * its own plugin instead.
 *
 * The tag tokens live in the root store's `jsails.tags` namespace. When the
 * root is the plugin's Valkey store, invalidations also travel between the
 * app's processes on a {@link ValkeyTagBus}; every table re-reads its warm
 * tags each `tags.syncMs` (5 s) whatever the bus does. With any other root
 * the plugin cannot tell whether other processes share it, so the bus is on
 * only when `tags.bus` is `true` (it then needs the app's Valkey).
 *
 * Setup connects nothing: a Valkey connection opens on first use. A
 * connection set the plugin creates from `VALKEY_URL` or `leases.url` is its
 * own: no other plugin reaches it, and the cleanup closes it. The cleanup
 * closes the tag table first, then only what the plugin created.
 */

import {
  CacheErrors,
  cacheStoreToken,
  cacheTagsToken,
  cacheToken,
  createCacheTags,
  leaseToken,
  type CacheService,
  type CacheStore,
  type CacheTags,
  type LeaseStore,
} from 'jsails/cache';
import {
  definePlugin,
  envVar,
  tokenRef,
  type PluginFactory,
  type ServiceToken,
} from 'jsails/kernel';
import {
  assertConnectionUrl,
  createValkeyConnections,
  defaultAppPrefix,
  valkeyToken,
  type ValkeyConnections,
} from 'jsails/plugin-sdk';
import { z } from 'jsails/zod';

import { MemoryCacheStore } from './memory-cache-store.js';
import { MemoryLeaseStore } from './memory-lease-store.js';
import { VALKEY_KEY_PREFIX } from './valkey-backend.js';
import { ValkeyCacheStore } from './valkey-cache-store.js';
import { ValkeyLeaseStore } from './valkey-lease-store.js';
import { ValkeyTagBus } from './valkey-tag-bus.js';

/**
 * Lease settings accepted by {@link CachePluginOptions.leases}.
 *
 * @public
 */
export interface CacheLeaseOptions {
  /** Key prefix for the Valkey-backed leases. Defaults to `<app key prefix>:lease`. */
  readonly prefix?: string;
  /**
   * A second Valkey (`redis://` or `rediss://`) for the leases alone, so they
   * can live on a server that evicts nothing while the cache's evicts freely.
   * Defaults to the app's connections.
   */
  readonly url?: string;
}

/**
 * Tag token settings accepted by {@link CachePluginOptions.tags}.
 *
 * @public
 */
export interface CacheTagOptions {
  /** How often each process re-reads its warm tags, in milliseconds. Defaults to 5000. */
  readonly syncMs?: number;
  /**
   * Carry invalidations between processes on Valkey pub/sub. Defaults to on
   * when the cache is the plugin's Valkey store and off otherwise; `true`
   * with any other root needs the app's Valkey.
   */
  readonly bus?: boolean;
}

/**
 * Options accepted by {@link cachePlugin}.
 *
 * @public
 */
export interface CachePluginOptions {
  /**
   * The root store: `'memory'`, `'valkey'`, or a `cacheStoreToken` another
   * plugin provides. Defaults to Valkey when the app has it, else memory.
   */
  readonly store?: 'memory' | 'valkey' | ServiceToken<CacheStore>;
  /** Key prefix for the Valkey-backed cache. Defaults to `<app key prefix>:cache`. */
  readonly prefix?: string;
  /** Byte budget of the in-memory cache. Defaults to 64 MiB. */
  readonly maxBytes?: number;
  /** Entry budget of the in-memory cache. Defaults to 100 000. */
  readonly maxEntries?: number;
  /** Also provide a lease store under `leaseToken`. Off by default. */
  readonly leases?: boolean | CacheLeaseOptions;
  /** How the tag tokens of defined caches are kept current. */
  readonly tags?: CacheTagOptions;
}

/** The root store's namespace holding the tag tokens. */
const TAGS_NAMESPACE = 'jsails.tags';

/** The client name of the plugin's own provider from `VALKEY_URL`. */
const CACHE_CLIENT_NAME = 'jsails-cache';

/** The client name of the leases' own provider. */
const LEASE_CLIENT_NAME = 'jsails-leases';

/** Whether `value` parses as a `redis://` or `rediss://` URL. */
function isValkeyUrl(value: string): boolean {
  try {
    assertConnectionUrl(
      value,
      () => new CacheErrors.Error('invalid_option', { option: 'leases.url' }),
    );
    return true;
  } catch {
    return false;
  }
}

const prefixSchema = z.string().regex(VALKEY_KEY_PREFIX, { message: 'must be a key prefix' });

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const cacheOptions: z.ZodType<CachePluginOptions> = z
  .object({
    store: z.union([z.enum(['memory', 'valkey']), tokenRef(cacheStoreToken)]).optional(),
    prefix: prefixSchema.optional(),
    maxBytes: positiveInteger.optional(),
    maxEntries: positiveInteger.optional(),
    leases: z
      .union([
        z.boolean(),
        z
          .object({
            prefix: prefixSchema.optional(),
            url: z
              .string()
              .refine(isValkeyUrl, { message: 'must be a redis:// or rediss:// URL' })
              .optional(),
          })
          .strict(),
      ])
      .optional(),
    tags: z
      .object({ syncMs: positiveInteger.optional(), bus: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();

/** The lease settings `leases` asks for, or `undefined` when it asks for none. */
function leaseOptions(value: CachePluginOptions['leases']): CacheLeaseOptions | undefined {
  if (value === undefined || value === false) return undefined;
  return value === true ? {} : value;
}

/**
 * The first-party `cache` plugin. Stores are chosen during setup (cheap, no
 * connection) and a Valkey connection opens on first use.
 *
 * @public
 */
export const cachePlugin: PluginFactory<CachePluginOptions | undefined> = definePlugin({
  name: 'cache',
  options: cacheOptions.optional(),
  env: { VALKEY_URL: envVar.url().optional() },
  requires: (options) => [typeof options?.store === 'object' ? options.store : undefined],
  optional: [valkeyToken],
  provides: (options) => [
    cacheToken,
    cacheTagsToken,
    leaseOptions(options?.leases) === undefined ? undefined : leaseToken,
  ],
  setup({ options = {}, env, services, rootDir, mode }) {
    const leases = leaseOptions(options.leases);
    const provided = typeof options.store === 'object' ? services.get(options.store) : undefined;
    const valkeyRootAllowed = options.store === 'valkey' || options.store === undefined;
    const owned: { close(): Promise<void> }[] = [];

    // The app's connections: another plugin's, else the plugin's own from
    // VALKEY_URL, created only when something here would use them.
    let connections: ValkeyConnections | undefined;
    if (
      valkeyRootAllowed ||
      options.tags?.bus === true ||
      (leases !== undefined && leases.url === undefined)
    ) {
      connections = services.tryGet(valkeyToken);
      if (connections === undefined && env.VALKEY_URL !== undefined) {
        connections = ownConnections(
          env.VALKEY_URL,
          defaultAppPrefix(rootDir, { NODE_ENV: mode }),
          'store',
        );
        owned.push(connections);
      }
    }
    if (options.store === 'valkey' && connections === undefined) {
      throw new CacheErrors.Error('invalid_option', { option: 'store' });
    }
    const valkeyRoot = valkeyRootAllowed ? connections : undefined;
    const busConnections =
      options.tags?.bus === false || (valkeyRoot === undefined && options.tags?.bus !== true)
        ? undefined
        : connections;
    if (options.tags?.bus === true && busConnections === undefined) {
      throw new CacheErrors.Error('invalid_option', { option: 'tags.bus' });
    }

    const root = provided ?? ownedCache(options, valkeyRoot);
    // Stores close before the providers they run on, so each goes first.
    if (provided === undefined) owned.unshift(root);
    const service: CacheService = Object.freeze({
      cache: (name: string): CacheStore => root.namespace(name),
    });
    services.provide(cacheToken, service);

    if (leases !== undefined) {
      let leaseConnections = connections;
      if (leases.url !== undefined) {
        leaseConnections = ownConnections(
          leases.url,
          connections?.prefix ?? defaultAppPrefix(rootDir, { NODE_ENV: mode }),
          'leases.url',
        );
        owned.push(leaseConnections);
      }
      const store: LeaseStore =
        leaseConnections === undefined
          ? new MemoryLeaseStore()
          : new ValkeyLeaseStore({
              connections: leaseConnections,
              ...(leases.prefix === undefined ? {} : { prefix: leases.prefix }),
            });
      owned.unshift(store);
      services.provide(leaseToken, store);
    }

    const tags: CacheTags = createCacheTags({
      store: root.namespace(TAGS_NAMESPACE),
      ...(busConnections === undefined
        ? {}
        : { bus: new ValkeyTagBus({ connections: busConnections }) }),
      ...(options.tags?.syncMs === undefined ? {} : { syncMs: options.tags.syncMs }),
    });
    services.provide(cacheTagsToken, tags);

    return async () => {
      // The tag table stops first: its sync reads the root store.
      await tags.close();
      for (const resource of owned) await resource.close();
    };
  },
});

/** A connection set the plugin owns; a refused URL names the option, never the URL. */
function ownConnections(
  url: string,
  appPrefix: string,
  option: 'store' | 'leases.url',
): ValkeyConnections {
  try {
    return createValkeyConnections(url, {
      appPrefix,
      name: option === 'store' ? CACHE_CLIENT_NAME : LEASE_CLIENT_NAME,
    });
  } catch (error) {
    throw new CacheErrors.Error('invalid_option', { option }, { cause: error });
  }
}

function ownedCache(
  options: CachePluginOptions,
  connections: ValkeyConnections | undefined,
): CacheStore {
  if (connections === undefined) {
    return new MemoryCacheStore({
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    });
  }
  return new ValkeyCacheStore({
    connections,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  });
}
