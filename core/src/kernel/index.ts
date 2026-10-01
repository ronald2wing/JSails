/**
 * `jsails/kernel`: the plugin contract and the app definition.
 *
 * `defineApp` is the default export of an app's `jsails.config.ts`; the
 * `AppConfig` types describe what its config function returns, and
 * `isSchemaAuthority` recognises the capability the kernel mints in managed
 * mode. The loader and the plugin resolver are on the root entry: they load
 * the runtime, and a config module must not.
 *
 * `definePlugin` and the schema helpers its options and environment use
 * (`fn`, `tokenRef`, `moduleOption`, `envVar`), `moduleRef` for naming app
 * code in options, `lazy` for a setup or contribution module loaded on first
 * use, `parseOptions`, `loadPluginContribution`, the setup-context, lifecycle
 * and substrate types, and the contract's error registries. A plugin's config
 * entry imports this subpath (and zod) and nothing heavier, so an
 * application config that lists the plugin loads no database, queue or HTTP
 * runtime.
 *
 * The service token API (`createServiceToken`, keyed and live tokens) is
 * re-exported here so a plugin needs no other framework import. It is not on
 * `jsails/services`: that subpath projects framework globals, and sharing
 * names with `jsails/extensions` there would publish a `services` namespace
 * object on `globalThis`. The inert-setup harness `testPlugin` lives in
 * `jsails/testing`.
 *
 * A setup registers its HTTP routes through `routes`, an `HttpRoutes`
 * registrar; the route types and `publicAccess` (every route
 * states its access) are here for that, so a route-registering plugin needs
 * no heavier entry.
 *
 * `defineCommand` writes a command a package lists in its `jsails.commands`
 * or an app keeps under `commands/`; the command surface loads no runtime
 * either.
 */

export {
  createServiceToken,
  isServiceToken,
  type ServiceToken,
  type ServiceTokenFamily,
  type ServiceTokenOptions,
} from '../extensions/services.js';

export {
  definePlugin,
  isPluginFactory,
  parseOptions,
  type PluginFactory,
  type PluginOptionsInput,
  type PluginOptionsOutput,
  type PluginSpec,
  type PluginTokenDeclaration,
} from '../plugins/contract/define-plugin.js';

export {
  isLazyModule,
  isPluginInstance,
  lazy,
  PLUGIN_CONTRIBUTION_SLOTS,
  type LazyModule,
  type PluginCleanup,
  type PluginContributions,
  type PluginContributionSlot,
  type PluginDefinition,
  type PluginEnvOf,
  type PluginEnvSchema,
  type PluginInstance,
  type PluginMode,
  type PluginServices,
  type PluginSetup,
  type PluginSchemaContribution,
  type PluginSetupContext,
  type SubstrateContext,
  type SubstrateHandle,
  type SubstrateResource,
} from '../plugins/contract/instance.js';

export { loadPluginContribution } from '../plugins/contract/contributions.js';

export { isModuleRef, moduleRef, type ModuleRef } from '../plugins/contract/module-ref.js';

export {
  boundObject,
  checkOptionSchema,
  envVar,
  fn,
  moduleOption,
  tokenRef,
  type OptionSchemaFinding,
  type SecretVariableOptions,
  type StringVariableOptions,
} from '../plugins/contract/option-schemas.js';

export { describePluginEnv, type PluginEnvVariable } from '../plugins/contract/env-variables.js';

export {
  isPluginRole,
  PLUGIN_ROLES,
  type LifecycleRegisterOptions,
  type LifecycleRegistration,
  type LifecycleTransport,
  type LifecycleUnit,
  type PluginLifecycle,
  type PluginRole,
  type TransportReach,
} from '../plugins/contract/lifecycle.js';

export { ConfigErrors, PluginErrors } from '../plugins/contract/errors.js';

export { publicAccess, type AccessRef, type RouteAccess } from '../api/access-ref.js';
export type { RequestContext, RouteContext } from '../contracts/http.js';
export type { RouteMiddleware } from '../routing/middleware.js';
export type {
  FetchHandler,
  HttpRoutes,
  MountOptions,
  RouteMethod,
  RouteSpec,
} from '../server/http-routes.js';
export type { ResponseTransform } from '../server/route-boundary.js';
export type { TransformableKind } from '../server/route-meta.js';
export type { CredentialKind } from '../security/credentials.js';

export { defineApp, type AppDefinition, type AppDefinitionInput } from './define-app.js';

export * from '../entry/cli-surface.js';

export { isSchemaAuthority, type SchemaAuthority } from './activation/schema-authority.js';

export type {
  ActivationConfig,
  ActivationMode,
  AppConfig,
  AppPluginsConfig,
  JsailsAppConfig,
} from '../app/config/schema.js';
