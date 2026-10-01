/**
 * Root-only application runtime surface: the config loader, inert app
 * assembly, and the in-memory starter scaffold generator.
 */

export {
  ApplicationError,
  createApplication,
  type Application,
  type ApplicationErrorCode,
  type ServeHandle,
} from '../app/application.js';

export {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  defineAppConfig,
  loadAppConfig,
  validateAppConfig,
  type AppCleanup,
  type AppConfigLoadOptions,
  type AppConfigValidationOptions,
  type AppSetup,
  type ConfigSchemaIssue,
  type JsailsAppConfig,
  type ResolvedAppConfig,
} from '../app/config/index.js';

export {
  createStarterFiles,
  StarterError,
  type StarterFiles,
  type StarterOptions,
} from '../app/starter/index.js';
