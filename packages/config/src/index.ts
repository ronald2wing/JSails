/**
 * First-party config (`@jsails/config`): settings that are edited in the
 * admin, exported to files you commit, imported on deploy, and optionally
 * forced from code — Drupal's configuration management for JSails.
 *
 * Declare a set with {@link defineConfig} and the field helpers, register it
 * with {@link configPlugin}, and read it through the {@link Config} service.
 * Storage is a {@link ConfigStore}: in memory by default, or the
 * `jsails_config` table through {@link createDatabaseConfigStore}. The admin
 * page lives on the separate `@jsails/config/admin` subpath. Importing this
 * barrel is inert.
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

export { createConfig, type Config, type ConfigOptions, type ConfigOverrides } from './config.js';

export { createMemoryConfigStore, type ConfigStore, type ConfigStoreEntry } from './store.js';

export { JsailsConfigEntry, configEntities, CONFIG_TABLE } from './entities.js';

export { createDatabaseConfigStore, type DatabaseConfigStoreOptions } from './database-store.js';

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
  configToken,
  type ConfigPlugin,
  type ConfigPluginOptions,
} from './plugin.js';

// `plugins.use` resolves a specifier by importing the default export and
// calling it with the options tuple.
export { configPlugin as default } from './plugin.js';
