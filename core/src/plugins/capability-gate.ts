/**
 * Manifest permission checks for activated plugins.
 *
 * A plugin installed through the managed surface declares `permissions` in its
 * manifest. {@link gatePluginCapabilities} wraps such a plugin so that each
 * framework capability its `setup` context grants is refused unless the
 * matching permission is declared:
 *
 * | Context capability                       | Required permission      |
 * | ---------------------------------------- | ------------------------ |
 * | `configureHttp`                          | `http.routes`            |
 * | `configureMiddleware`                    | `http.middleware`        |
 * | `onServe`                                | `http.serve`             |
 * | `intercept`, `interceptorRegistry.intercept` | `interceptors.register` |
 * | `observe`, `interceptorRegistry.observe` | `events.observe`         |
 * | `services.provide(…, { replace: true })` | `services.replace`       |
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
 * Services other extensions expose are outside the gate: a plugin that obtains
 * a shared signals bus through `services.get` (`@jsails/signals` wraps this
 * same registry) registers observers through that service under its
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

/** The permission each gated setup-context capability requires. */
export const PLUGIN_CAPABILITY_PERMISSIONS = Object.freeze({
  configureHttp: 'http.routes',
  configureMiddleware: 'http.middleware',
  onServe: 'http.serve',
  intercept: 'interceptors.register',
  observe: 'events.observe',
  replaceService: 'services.replace',
} as const);

/** Stable failure code carried by {@link PluginPermissionError}. */
export type PluginPermissionErrorCode = 'missing_permission';

/** Raised when an activated plugin uses a capability its manifest did not declare. */
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
        return setup.call(plugin, gateContext(context as PluginContext, demand));
      },
    },
  ) as JsailsPlugin;
  return gated;
}

/** The runtime shape behind `PluginContext.intercept`'s two overloads. */
type AnyIntercept = (
  operation: OperationToken<unknown, unknown>,
  fn: BeforeInterceptor<unknown> | AfterInterceptor<unknown, unknown>,
  options?: { phase?: 'before' | 'after' },
) => void;

function gateContext(context: PluginContext, demand: (permission: string) => void): PluginContext {
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
  const gated: PluginContext = {
    services,
    configureHttp(hook) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS.configureHttp);
      context.configureHttp(hook);
    },
    configureMiddleware(handler) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS.configureMiddleware);
      context.configureMiddleware(handler);
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
      demand(PLUGIN_CAPABILITY_PERMISSIONS.intercept);
      registry.intercept(operation, fn, options);
    },
    observe(event, fn, options) {
      demand(PLUGIN_CAPABILITY_PERMISSIONS.observe);
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
