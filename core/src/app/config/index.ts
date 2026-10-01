/**
 * Application configuration for the JSails server/worker runtime.
 *
 * An application states its config in one module: `jsails.config.ts`, whose
 * default export is `defineApp(...)` (from `jsails/kernel`), or the legacy
 * `jsails.app.js`, whose default export is the config object. The kernel
 * loader (`loadApp`) imports it; {@link validateAppConfig} resolves a config
 * object built in code into a {@link ResolvedAppConfig} with every directory
 * made absolute:
 *
 * - `rootDir` is relative to the config file's directory;
 * - `storage` and the legacy `pages`/`api`/`public`/`out` are relative to
 *   `rootDir`.
 *
 * Resolution is inert: it never creates a directory, loads a `.env` file,
 * opens a connection, installs a signal handler, or invokes a callback, an
 * extension's `setup`, a renderer or a command. Callbacks and objects pass
 * through by identity.
 *
 * Errors are value-free `AppConfigError`s, plus the `config.removed_option`
 * registry error for an option already removed.
 *
 * This is the assembly barrel. The kept keys (the {@link AppConfig}
 * interface and its schema) live in `schema.ts`; the legacy keys, their
 * validation and their replacements in `legacy.ts`, the compat mapper; the
 * default constants in `defaults.ts`; {@link AppConfigError} in `errors.ts`;
 * lexical path resolution and the private-directory isolation guards in
 * `paths.ts`; and the resolve pass and the environment overrides in
 * `load.ts`. Only the public surface below is re-exported.
 */

export { AppConfigError, isAppConfigError, type ConfigSchemaIssue } from './errors.js';
export {
  DEFAULT_APP_CONFIG_PATH,
  DEFAULT_APP_HOST,
  DEFAULT_APP_PORT,
  APP_HOST_ENV,
  APP_PORT_ENV,
  DEFAULT_APP_PAGES_DIR,
  DEFAULT_APP_API_DIR,
  DEFAULT_APP_PUBLIC_DIR,
  DEFAULT_APP_OUT_DIR,
  DEFAULT_APP_STORAGE_DIR,
  DEFAULT_HEALTH_PATH,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  MAX_SHUTDOWN_TIMEOUT_MS,
} from './defaults.js';
export {
  type ActivationConfig,
  type ActivationMode,
  type AppCleanup,
  type AppConfig,
  type AppConfigValidationOptions,
  type AppPluginsConfig,
  type AppRenderConfig,
  type AppTelemetryConfig,
  type AppHttpConfig,
  type AppServerConfig,
  type AppServerTimeouts,
  type ResolvedHttpConfig,
  type ResolvedServerConfig,
  type PluginUseEntry,
  type JsailsAppConfig,
  type ResolvedAppConfig,
  type ResolvedPluginsConfig,
} from './schema.js';
export {
  LEGACY_CONFIG_ROOT,
  LEGACY_CONFIG_SURFACES,
  type AppSetup,
  type IntrospectConfig,
  type I18nConfig,
  type LegacyAppConfig,
  type LegacyConfigSurface,
  type LegacyPluginUseEntry,
  type ResolvedI18nConfig,
  type ResolvedIntrospectConfig,
  type ResolvedLegacyAppConfig,
  type ResolvedSeoConfig,
  type SeoConfig,
} from './legacy.js';

export { validateAppConfig, type ConfigEnvironment } from './load.js';
