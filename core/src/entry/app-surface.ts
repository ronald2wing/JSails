/**
 * Root-only application runtime surface: the kernel pipeline (load the app,
 * resolve its plugin graph, open its services, start its lifecycle units),
 * inert app assembly, and the in-memory starter scaffold generator.
 */

export {
  ApplicationError,
  createApplication,
  type Application,
  type ApplicationErrorCode,
  type CreateApplicationOptions,
  type ServeHandle,
  type ServeOptions,
  type StandbyServer,
} from '../app/application.js';
export type { ListenHandle } from '../app/serve.js';
export { ServeErrors } from '../app/serve-errors.js';

export {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  validateAppConfig,
  type ActivationConfig,
  type ActivationMode,
  type AppCleanup,
  type AppConfig,
  type AppConfigValidationOptions,
  type AppSetup,
  type ConfigEnvironment,
  type ConfigSchemaIssue,
  type JsailsAppConfig,
  type LegacyAppConfig,
  type ResolvedAppConfig,
} from '../app/config/index.js';

export {
  createLoadedApp,
  loadApp,
  type CreateLoadedAppOptions,
  type LoadAppOptions,
  type LoadedApp,
} from '../kernel/load-app.js';

export {
  activationModeOf,
  resolvePlugins,
  type PluginGraph,
  type PluginGraphNode,
  type PluginGraphOrigin,
  type ResolvePluginsOptions,
} from '../kernel/resolve-plugins.js';

export {
  openServices,
  type OpenServicesOptions,
  type Services,
  type ServicesPurpose,
} from '../kernel/open-services.js';

export {
  start,
  type AdoptedUnit,
  type HostUnit,
  type Kernel,
  type ShutdownOptions,
  type ShutdownReport,
  type StartOptions,
} from '../kernel/start.js';

export { KernelStageErrors } from '../kernel/errors.js';

export {
  createStarterFiles,
  StarterError,
  type StarterFiles,
  type StarterOptions,
} from '../app/starter/index.js';
