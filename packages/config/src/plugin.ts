/**
 * First-party `config` plugin: provides the {@link Config} service under a
 * typed token, declares the `jsails_config` table for `db:push` when given a
 * store, and contributes the `config:export` / `config:import` commands.
 *
 * `configPlugin({ sets, store?, overrides?, syncDir? })` builds the service
 * eagerly, so a duplicate set or an invalid override fails when the app config
 * loads. Construction opens nothing: a database store connects on its first
 * read or write. Without a `store`, values live in memory.
 */

import {
  createServiceToken,
  definePlugin,
  type JsailsPlugin,
  type ServiceToken,
} from 'jsails/extensions';

import { configCommands } from './commands.js';
import { createConfig, type Config, type ConfigOverrides } from './config.js';
import { ConfigError } from './config-error.js';
import type { ConfigSet } from './config-set.js';
import { configEntities } from './entities.js';
import { createMemoryConfigStore, isConfigStore, type ConfigStore } from './store.js';
import { DEFAULT_SYNC_DIR } from './sync.js';

/** Token for the app's {@link Config} service. */
export const configToken: ServiceToken<Config> = createServiceToken<Config>('config');

/** Options for {@link configPlugin}. */
export interface ConfigPluginOptions {
  /** Every config set the app uses, its own and its plugins'. */
  readonly sets: readonly ConfigSet[];
  /** Where active values live; defaults to memory. */
  readonly store?: ConfigStore;
  /** Values forced from code, by set then key. */
  readonly overrides?: ConfigOverrides;
  /** The sync directory, relative to the app config; defaults to `config/sync`. */
  readonly syncDir?: string;
  /** How long resolved values stay cached, in milliseconds; see {@link createConfig}. */
  readonly cacheTtlMs?: number;
}

/** The plugin plus the service it provides, for wiring the admin page. */
export interface ConfigPlugin extends JsailsPlugin {
  readonly config: Config;
}

/** Create the `config` plugin. */
export function configPlugin(options: ConfigPluginOptions): ConfigPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ConfigError('invalid_options', 'configPlugin requires an options object');
  }
  if (options.store !== undefined && !isConfigStore(options.store)) {
    throw new ConfigError('invalid_options', 'store must be a config store');
  }
  if (
    options.syncDir !== undefined &&
    (typeof options.syncDir !== 'string' || options.syncDir === '')
  ) {
    throw new ConfigError('invalid_options', 'syncDir must be a non-empty path');
  }
  const config = createConfig({
    store: options.store ?? createMemoryConfigStore(),
    sets: options.sets,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
  });
  const plugin = definePlugin({
    name: 'config',
    // The table is declared only when values are persisted: an in-memory
    // config needs none.
    ...(options.store === undefined ? {} : { schema: { entities: configEntities } }),
    commands: configCommands(config, options.syncDir ?? DEFAULT_SYNC_DIR),
    setup({ services }) {
      services.provide(configToken, config);
    },
  });
  return Object.freeze({ ...plugin, config });
}
