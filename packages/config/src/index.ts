/**
 * First-party config (`@jsails/config`): settings that are edited in the
 * admin, exported to files you commit, imported on deploy, and optionally
 * forced from code — Drupal's configuration management for JSails.
 *
 * Declare a set with {@link defineConfig} and the field helpers, register it
 * with {@link configPlugin}, and read it through the {@link Config} service.
 * Storage is a {@link ConfigStore}: in memory by default, or the
 * `jsails_config` table through `createDatabaseConfigStore` from
 * `@jsails/config/database` (which loads TypeORM), provided by an app plugin
 * under {@link configStoreToken}. The admin page lives on the
 * separate `@jsails/config/admin` subpath, and the `config:export` /
 * `config:import` commands on `@jsails/config/commands/*`, which the package's
 * `jsails.commands` lists. Importing this barrel is inert.
 */

export { ConfigError, type ConfigErrorCode } from './config-error.js';

export {
  boolean,
  choice,
  integer,
  json,
  text,
  type BooleanFieldOptions,
  type ChoiceFieldOptions,
  type ConfigField,
  type ConfigFieldKind,
  type IntegerFieldOptions,
  type JsonFieldOptions,
  type TextFieldOptions,
} from './fields.js';

export {
  defineConfig,
  type ConfigFields,
  type ConfigSet,
  type ConfigSetOptions,
  type ConfigValues,
} from './config-set.js';

export {
  CONFIG_CACHE,
  configTag,
  createConfig,
  type Config,
  type ConfigCache,
  type ConfigOptions,
  type ConfigOverrides,
  type ResolvedConfigValues,
} from './config.js';

export { createMemoryConfigStore, type ConfigStore, type ConfigStoreEntry } from './store.js';

export {
  CONFIG_SYNC_FORMAT,
  CONFIG_SYNC_VERSION,
  DEFAULT_SYNC_DIR,
  applyImport,
  exportConfig,
  planImport,
  type ConfigExportResult,
  type ConfigImportChange,
  type ConfigImportPlan,
} from './sync.js';

export {
  configPlugin,
  configStoreToken,
  configSyncToken,
  configToken,
  type ConfigPluginOptions,
  type ConfigSync,
} from './plugin.js';

// `plugins.use` resolves a specifier by importing the default export and
// calling it with the options tuple.
export { configPlugin as default } from './plugin.js';
