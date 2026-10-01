/**
 * First-party `config` plugin: provides the {@link Config} service under
 * {@link configToken}, and where the sync files live under
 * {@link configSyncToken}.
 *
 * `configPlugin({ sets, store?, overrides?, syncDir? })` configures a plugin
 * named `config` on the `definePlugin` contract. Its options are checked by a
 * strict schema when the factory is called (a failure is
 * `config.invalid_options`, before anything runs): every set must come from
 * {@link defineConfig}, a set name may appear once, and every override must
 * name a declared key with a valid value.
 *
 * - `store` names the {@link ConfigStore} another plugin provides under
 *   {@link configStoreToken} (or a keyed member); it is used verbatim and
 *   never closed here, since its provider owns it. Without it values live in
 *   memory.
 * - `syncDir` is the sync directory, relative to the application root;
 *   `config/sync` by default.
 *
 * The service's reads go through a cache defined over the `cache` plugin's
 * services, which the plugin therefore requires. It owns the `jsails_config`
 * table (its `schema` contribution), which `createDatabaseConfigStore` uses. Setup opens nothing: a
 * database store connects on its first read or write. The admin page and the
 * `config:export` / `config:import` commands (this package's
 * `jsails.commands`) reach the same service through its token.
 */

import { isAbsolute, resolve } from 'node:path';

import { cacheTagsToken, cacheToken, defineCache } from 'jsails/cache';
import {
  boundObject,
  createServiceToken,
  definePlugin,
  fn,
  lazy,
  tokenRef,
  type PluginFactory,
  type ServiceToken,
  type ServiceTokenFamily,
} from 'jsails/kernel';
import { z } from 'jsails/zod';

import { CONFIG_CACHE, createConfig, type Config, type ConfigOverrides } from './config.js';
import { ConfigError } from './config-error.js';
import type { ConfigSet } from './config-set.js';
import { createMemoryConfigStore, type ConfigStore } from './store.js';
import { DEFAULT_SYNC_DIR } from './sync.js';

/** Token for the app's {@link Config} service. */
export const configToken: ServiceToken<Config> = createServiceToken<Config>('config');

/**
 * Token family for a {@link ConfigStore} another plugin provides, named by
 * `configPlugin({ store: configStoreToken })`.
 *
 * @public
 */
export const configStoreToken: ServiceTokenFamily<ConfigStore> =
  createServiceToken<ConfigStore>('config.store');

/**
 * Where the app's config sync files live.
 *
 * @public
 */
export interface ConfigSync {
  /** The absolute sync directory. */
  readonly dir: string;
}

/**
 * Token for the app's {@link ConfigSync}, which the sync commands read.
 *
 * @public
 */
export const configSyncToken: ServiceToken<ConfigSync> =
  createServiceToken<ConfigSync>('config.sync');

/** Options accepted by {@link configPlugin}. */
export interface ConfigPluginOptions {
  /** Every config set the app uses, its own and its plugins'. */
  readonly sets: readonly ConfigSet[];
  /** The store another plugin provides; values live in memory without one. */
  readonly store?: ServiceToken<ConfigStore>;
  /** Values forced from code, by set then key. */
  readonly overrides?: ConfigOverrides;
  /** The sync directory, relative to the application root; defaults to `config/sync`. */
  readonly syncDir?: string;
}

/** One field as the field helpers build it: data and its three functions. */
const fieldSchema = boundObject({
  kind: z.enum(['text', 'integer', 'boolean', 'choice', 'json']),
  label: z.string().optional(),
  default: z.json(),
  required: z.boolean().optional(),
  multiline: z.boolean().optional(),
  max: z.number().optional(),
  min: z.number().optional(),
  options: z.array(z.string()).optional(),
  check: fn<(value: unknown) => unknown>(),
  fromForm: fn<(raw: string | undefined) => unknown>(),
  toForm: fn<(value: unknown) => string>(),
});

/** One set as `defineConfig` builds it. */
const setSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().optional(),
    fields: z.record(z.string(), fieldSchema),
  })
  .strict();

const configOptions = z
  .object({
    sets: z.array(setSchema),
    store: tokenRef(configStoreToken).optional(),
    overrides: z.record(z.string(), z.record(z.string(), z.json())).optional(),
    syncDir: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((options, context) => {
    // The service's own checks (a duplicate set, an override of an undeclared
    // key or with an invalid value) run once here, over a throwaway memory
    // store, so a bad option fails when the app config loads.
    try {
      createConfig({
        store: createMemoryConfigStore(),
        sets: options.sets,
        ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      context.addIssue({ code: 'custom', message: error.message, path: ['sets'] });
    }
  }) as unknown as z.ZodType<ConfigPluginOptions>;

/** The sync directory `syncDir` names, against the application root. */
function syncDirectory(rootDir: string, syncDir: string | undefined): string {
  const dir = syncDir ?? DEFAULT_SYNC_DIR;
  return isAbsolute(dir) ? dir : resolve(rootDir, dir);
}

/** The first-party `config` plugin. Nothing is read until the service is used. */
export const configPlugin: PluginFactory<ConfigPluginOptions> = definePlugin({
  name: 'config',
  options: configOptions,
  requires: (options) => [cacheToken, cacheTagsToken, options.store],
  provides: [configToken, configSyncToken],
  // The `jsails_config` table belongs to this package, so the schema commands
  // create it (and keep it after the plugin is removed) whichever store the
  // app provides; the table stays empty over a memory store.
  schema: lazy(async () => ({
    default: { models: (await import('./database/entities.js')).configEntities },
  })),
  setup({ options, services, rootDir }) {
    const config = createConfig({
      store: options.store === undefined ? createMemoryConfigStore() : services.get(options.store),
      sets: options.sets,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      cache: defineCache(services, CONFIG_CACHE),
    });
    services.provide(configToken, config);
    services.provide(
      configSyncToken,
      Object.freeze({ dir: syncDirectory(rootDir, options.syncDir) }),
    );
  },
});
