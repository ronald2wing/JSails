/**
 * Manifest permission checks for managed plugins.
 *
 * A managed plugin declares `permissions` in its manifest. The framework
 * activates no managed plugin yet: until the marketplace plugin source does,
 * the gate runs only where an app calls it. {@link gatePluginCapabilities}
 * wraps such a plugin so that each
 * framework capability its `setup` context grants is refused unless the
 * matching permission is declared:
 *
 * | Context capability                       | Required permission      |
 * | ---------------------------------------- | ------------------------ |
 * | `routes.add`, `routes.mount`             | `http.routes`            |
 * | `routes.transform`                       | `http.transform`         |
 * | `configureRequestScope`                  | `http.scope`             |
 * | `configureGuard`, `routes.guard`         | `http.guard`             |
 * | `onServe`                                | `http.serve`             |
 * | `intercept`, `interceptorRegistry.intercept` | `interceptors.register` |
 * | `observe`, `interceptorRegistry.observe` | `events.observe`         |
 * | `services.provide(…, { replace: true })` | `services.replace`       |
 *
 * The declarative `readiness` field requires `health.readiness`: its probes
 * run plugin code on anonymous readiness requests and a failing one takes the
 * whole app out of rotation, so a plugin that declares any probe without the
 * permission is refused when its `setup` runs, before any of it is wired.
 *
 * This is a declaration check, not a sandbox: plugin code runs in-process with
 * the full privileges of the application, so it can still reach `node:fs`,
 * `process.env`, or the shared registries through other means. What it does
 * guarantee is that a plugin whose manifest says it adds no routes cannot add
 * routes through the framework, so the declared list an operator reviews at
 * install time matches what the framework wires. The `interceptorRegistry`
 * handle a gated plugin receives is a view whose registration methods carry
 * the same checks, and whose `seal` is inert because sealing the shared
 * registry is the runner's job, not one plugin's.
 *
 * The wrapper is marked as a managed plugin (`plugin-origin.ts`), so the
 * extension runner stamps its routes `managed-plugin` and never grants it
 * `routes.mount`.
 *
 * Services other extensions expose are outside the gate: a plugin that obtains
 * a shared signals bus through `services.get` (a `RegistrySignalBus` wraps
 * this same registry) registers observers through that service under its
 * provider's permissions, not its own. Plugins loaded through `plugins.use`
 * or `config.extensions` are developer code and are not gated.
 */

import type { ExtensionContext } from '../extensions/extension.js';
import type { PluginContext, JsailsPlugin } from '../extensions/plugin-contract.js';
import type {
  AfterInterceptor,
  BeforeInterceptor,
  InterceptorRegistry,
  OperationToken,
} from '../extensions/interceptors.js';
import type { ProvideOptions, ServiceRegistrar, ServiceToken } from '../extensions/services.js';
import { JsailsError } from '../errors/jsails-error.js';
import type { HttpRoutes } from '../server/http-routes.js';
import { isIdentifier } from '../errors/context-schema.js';
import { isRecord } from '../json/shape.js';
import { PluginErrors } from './contract/errors.js';
import type { PluginRole } from './contract/lifecycle.js';
import { markManagedPlugin } from './plugin-origin.js';

const pluginCapabilityPermissions = {
  'routes.add': 'http.routes',
  'routes.mount': 'http.routes',
  'routes.guard': 'http.guard',
  'routes.transform': 'http.transform',
  configureRequestScope: 'http.scope',
  configureGuard: 'http.guard',
  onServe: 'http.serve',
  intercept: 'interceptors.register',
  'interceptorRegistry.intercept': 'interceptors.register',
  observe: 'events.observe',
  'interceptorRegistry.observe': 'events.observe',
  replaceService: 'services.replace',
  readiness: 'health.readiness',
} as const;
/**
 * The permission each gated setup-context capability requires. A key is the
 * capability's path on the context (`onServe`, `routes.transform`), so a
 * reader of a plugin's source (the `plugin-manifests` gate) matches the calls
 * it finds to the permission the wrapper demands for each; `replaceService`
 * (a `replace: true` provide) and `readiness` (the plugin field) are the two
 * that are not context paths.
 */
export const PLUGIN_CAPABILITY_PERMISSIONS: typeof pluginCapabilityPermissions = Object.freeze(
  pluginCapabilityPermissions,
);

/** Stable failure code carried by {@link PluginPermissionError}. */
export type PluginPermissionErrorCode = 'missing_permission';

/** Raised when a gated plugin uses a capability its manifest did not declare. */
export class PluginPermissionError extends JsailsError {
  readonly code: PluginPermissionErrorCode = 'missing_permission';

  constructor(
    readonly pluginId: string,
    readonly permission: string,
  ) {
    // The id and the permission name are manifest identifiers, not secrets.
    super(`plugin "${pluginId}" did not declare the "${permission}" permission`);
  }
}

/**
 * Wrap `plugin` so its `setup` receives a context whose capabilities require
 * the declared `permissions`. The wrapper keeps the plugin's prototype and
 * every other field, so `describe()` and the declarative passthroughs still
 * work.
 */
export function gatePluginCapabilities(
  plugin: JsailsPlugin,
  pluginId: string,
  permissions: readonly string[],
): JsailsPlugin {
  const declared = new Set(permissions);
  const demand = (permission: string): void => {
    if (!declared.has(permission)) throw new PluginPermissionError(pluginId, permission);
  };
  const setup = plugin.setup;
  const gated = Object.assign(
    Object.create(Object.getPrototypeOf(plugin) as object | null),
    plugin,
    {
      setup(context: ExtensionContext) {
        if (plugin.readiness !== undefined && Object.keys(plugin.readiness).length > 0) {
          demand(PLUGIN_CAPABILITY_PERMISSIONS.readiness);
        }
        return setup.call(plugin, gateContext(context as PluginContext, demand, pluginId));
      },
    },
  ) as JsailsPlugin;
  markManagedPlugin(gated);
  return gated;
}

/** The runtime shape behind `PluginContext.intercept`'s two overloads. */
type AnyIntercept = (
  operation: OperationToken<unknown, unknown>,
  fn: BeforeInterceptor<unknown> | AfterInterceptor<unknown, unknown>,
  options?: { phase?: 'before' | 'after' },
) => void;

function gateContext(
  context: PluginContext,
  demand: (permission: string) => void,
  pluginId: string,
): PluginContext {
  const services: ServiceRegistrar = {
    has: (token) => context.services.has(token),
    tryGet: (token) => context.services.tryGet(token),
    get: (token) => context.services.get(token),
    provide<T>(token: ServiceToken<T>, value: T, options?: ProvideOptions): void {
      if (options?.replace === true) demand(PLUGIN_CAPABILITY_PERMISSIONS.replaceService);
      context.services.provide(token, value, options);
    },
  };
  const intercept: AnyIntercept = (operation, fn, options) => {
    demand(PLUGIN_CAPABILITY_PERMISSIONS.intercept);
    (context.intercept as AnyIntercept)(operation, fn, options);
  };
  const routes: HttpRoutes = Object.freeze({
    add(spec) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS['routes.add']);
      context.routes.add(spec);
    },
    mount(prefix, handler, options) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS['routes.mount']);
      context.routes.mount(prefix, handler, options);
    },
    guard(guard) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS['routes.guard']);
      context.routes.guard(guard);
    },
    transform(kinds, transform) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS['routes.transform']);
      context.routes.transform(kinds, transform);
    },
  } satisfies HttpRoutes);
  const gated: PluginContext = {
    services,
    rootDir: context.rootDir,
    mode: context.mode,
    routes,
    configureRequestScope(scope) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS.configureRequestScope);
      context.configureRequestScope(scope);
    },
    configureGuard(guard) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS.configureGuard);
      context.configureGuard(guard);
    },
    onServe(hook) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS.onServe);
      context.onServe(hook);
    },
    intercept,
    observe(event, fn) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS.observe);
      context.observe(event, fn);
    },
    interceptorRegistry: gateRegistry(context.interceptorRegistry, demand),
    lifecycle: Object.freeze({
      register(_roles: readonly PluginRole[], unit: unknown): void {
        // No permission grants long-running work outside a request: a
        // managed plugin's code runs only inside the framework's own calls.
        throw new PluginErrors.Error('lifecycle_unavailable', {
          plugin: isIdentifier(pluginId) ? pluginId : '_',
          unit: isRecord(unit) && isIdentifier(unit['name']) ? unit['name'] : '_',
        });
      },
    }),
  };
  return gated;
}

/**
 * A view of the shared registry whose registration methods require the same
 * permissions as the context's own `intercept`/`observe`, so the raw handle is
 * not a way around them.
 */
function gateRegistry(
  registry: InterceptorRegistry,
  demand: (permission: string) => void,
): InterceptorRegistry {
  const view: InterceptorRegistry = {
    intercept(operation, fn, options) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS['interceptorRegistry.intercept']);
      registry.intercept(operation, fn, options);
    },
    observe(event, fn, options) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS['interceptorRegistry.observe']);
      registry.observe(event, fn, options);
    },
    runBefore: (operation, args) => registry.runBefore(operation, args),
    runAfter: (operation, args, initialResult) => registry.runAfter(operation, args, initialResult),
    emit: (event, payload) => registry.emit(event, payload),
    hasObservers: (event) => registry.hasObservers(event),
    // The runner seals the shared registry once every setup has run; one plugin
    // sealing it early would block registration by the plugins after it.
    seal: () => undefined,
  };
  return Object.freeze(view);
}
