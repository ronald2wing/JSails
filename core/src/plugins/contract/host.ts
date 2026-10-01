/**
 * Running one plugin instance: the steps the application runner and the
 * testing harness share, so the harness checks exactly what the runner does.
 *
 * 1. `readPluginEnv` validates the instance's environment variables
 *    (`config.invalid_env`); the runner reads the process environment, the
 *    harness only what a test passes.
 * 2. `declareSubstrate` asks the plugin for its substrate resources, and
 *    `openSubstrate` registers each as a lazy handle the host closes later.
 * 3. `runPluginSetup` checks the required services, hands setup a context whose
 *    service view admits only declared tokens, loads a lazy setup module, and
 *    afterwards checks that every declared service was provided. Lifecycle
 *    registrations are validated here and handed to the host, whose policy
 *    decides what to do with them. The instance's HTTP registrar comes from
 *    the host, which decides what the instance may register; this module
 *    closes it when setup returns, as it closes the lifecycle.
 */

import { createLazyResource, type LazyResource } from '../../extensions/lazy-resource.js';
import {
  isServiceToken,
  type ServiceRegistrar,
  type ServiceToken,
} from '../../extensions/services.js';
import type { HttpRoutes } from '../../server/http-routes.js';
import { parsePluginEnv } from './env-variables.js';
import { PluginErrors } from './errors.js';
import {
  isLazyModule,
  runtimeDefinitionOf,
  type PluginCleanup,
  type PluginInstance,
  type PluginMode,
  type PluginServices,
  type PluginSetup,
  type PluginSetupContext,
  type SubstrateHandle,
  type SubstrateResource,
} from './instance.js';
import {
  checkLifecycleRegistration,
  type LifecycleRegistration,
  type PluginLifecycle,
  type PluginRole,
} from './lifecycle.js';

/** What a host gives the plugins it runs. */
export interface PluginHost {
  /** The registry every plugin of the host reads and provides into. */
  readonly registry: ServiceRegistrar;
  /** The roles the process runs. */
  readonly roles: ReadonlySet<PluginRole>;
  /** The mode the process runs in. */
  readonly mode: PluginMode;
  /** The absolute application root. */
  readonly rootDir: string;
  /** Accept or refuse a validated lifecycle registration. */
  readonly registerUnit: (registration: LifecycleRegistration) => void;
  /** The HTTP registrar of `instance`, with the grants this host gives it. */
  readonly routes: (instance: PluginInstance) => HttpRoutes;
  /** Run a setup call (the runner enters the ambient application scope here). */
  readonly run: <T>(call: () => T) => T;
}

/**
 * The instance's validated environment variables, read from `source` (the
 * process environment unless given).
 */
export function readPluginEnv(
  instance: PluginInstance,
  source?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, unknown>> {
  return parsePluginEnv(instance.name, runtimeDefinitionOf(instance).env, source);
}

function isSubstrateResource(value: unknown): value is SubstrateResource<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const resource = value as Record<string, unknown>;
  return (
    isServiceToken(resource['token']) &&
    typeof resource['create'] === 'function' &&
    typeof resource['close'] === 'function'
  );
}

/** The substrate resources the instance declares for its options, environment and application root. */
export function declareSubstrate(
  instance: PluginInstance,
  env: Readonly<Record<string, unknown>>,
  rootDir: string,
): readonly SubstrateResource<unknown>[] {
  const declare = runtimeDefinitionOf(instance).substrate;
  if (declare === undefined) return [];
  const declared: unknown = declare({ options: instance.options, env, rootDir });
  if (!Array.isArray(declared) || !declared.every(isSubstrateResource)) {
    throw new PluginErrors.Error('invalid_substrate', { plugin: instance.name });
  }
  return Object.freeze([...declared]);
}

/**
 * Register each resource under its token as a handle that opens it on first
 * use. Returns the resources, for the host to close once after every cleanup.
 */
export function openSubstrate(
  registry: ServiceRegistrar,
  resources: readonly SubstrateResource<unknown>[],
): readonly LazyResource<unknown>[] {
  return resources.map((resource) => {
    const lazy = createLazyResource({
      create: () => resource.create(),
      close: (value) => resource.close(value),
    });
    const handle: SubstrateHandle<unknown> = Object.freeze({
      get closed() {
        return lazy.closed;
      },
      get: () => lazy.get(),
    });
    registry.provide(resource.token, handle);
    return lazy;
  });
}

/** The setup-time service view: declared tokens only. */
function declaredServices(
  instance: PluginInstance,
  substrate: readonly SubstrateResource<unknown>[],
  registry: ServiceRegistrar,
  provided: Set<ServiceToken<unknown>>,
): PluginServices {
  const readable = new Set<ServiceToken<unknown>>([
    ...instance.requires,
    ...instance.optional,
    ...instance.provides,
    ...substrate.map((resource) => resource.token),
  ]);
  const providable = new Set(instance.provides);
  const checkRead = (token: ServiceToken<unknown>): void => {
    if (!readable.has(token)) {
      throw new PluginErrors.Error('undeclared_service', {
        plugin: instance.name,
        token: isServiceToken(token) ? token.name : '_',
        access: 'read',
      });
    }
  };
  return Object.freeze({
    has<T>(token: ServiceToken<T>): boolean {
      checkRead(token);
      return registry.has(token);
    },
    tryGet<T>(token: ServiceToken<T>): T | undefined {
      checkRead(token);
      return registry.tryGet(token);
    },
    get<T>(token: ServiceToken<T>): T {
      checkRead(token);
      return registry.get(token);
    },
    provide<T>(token: ServiceToken<T>, value: T): void {
      if (!providable.has(token)) {
        throw new PluginErrors.Error('undeclared_service', {
          plugin: instance.name,
          token: isServiceToken(token) ? token.name : '_',
          access: 'provide',
        });
      }
      registry.provide(token, value);
      provided.add(token);
    },
  });
}

async function loadSetup(instance: PluginInstance): Promise<PluginSetup> {
  const setup = runtimeDefinitionOf(instance).setup;
  if (!isLazyModule(setup)) return setup;
  const module: unknown = await setup.load();
  const loaded: unknown =
    module !== null && typeof module === 'object'
      ? (module as { readonly default?: unknown }).default
      : undefined;
  if (typeof loaded !== 'function') {
    throw new PluginErrors.Error('invalid_setup_module', { plugin: instance.name });
  }
  return loaded as PluginSetup;
}

/** `routes` refusing every call once `open` says setup is over. */
function closingRoutes(plugin: string, routes: HttpRoutes, open: () => boolean): HttpRoutes {
  const check = (): void => {
    if (!open()) throw new PluginErrors.Error('routes_closed', { plugin });
  };
  return Object.freeze({
    add(spec) {
      check();
      routes.add(spec);
    },
    mount(prefix, handler, options) {
      check();
      routes.mount(prefix, handler, options);
    },
    guard(guard) {
      check();
      routes.guard(guard);
    },
    transform(kinds, transform) {
      check();
      routes.transform(kinds, transform);
    },
  } satisfies HttpRoutes);
}

/**
 * Run the instance's setup on `host`. Returns the cleanup it returned. A
 * declared service the setup did not provide fails after that cleanup ran.
 */
export async function runPluginSetup(
  instance: PluginInstance,
  env: Readonly<Record<string, unknown>>,
  substrate: readonly SubstrateResource<unknown>[],
  host: PluginHost,
): Promise<PluginCleanup | undefined> {
  for (const token of instance.requires) {
    if (!host.registry.has(token)) {
      throw new PluginErrors.Error('missing_service', {
        plugin: instance.name,
        token: token.name,
      });
    }
  }
  const provided = new Set<ServiceToken<unknown>>();
  let settingUp = true;
  const lifecycle: PluginLifecycle = Object.freeze({
    register(roles: readonly PluginRole[], unit: unknown, options?: unknown): void {
      if (!settingUp) {
        throw new PluginErrors.Error('invalid_lifecycle_unit', {
          plugin: instance.name,
          problem: 'after_setup',
        });
      }
      host.registerUnit(checkLifecycleRegistration(instance.name, roles, unit, options));
    },
  });
  const context: PluginSetupContext<unknown, Readonly<Record<string, unknown>>> = Object.freeze({
    name: instance.name,
    key: instance.key,
    options: instance.options,
    env,
    services: declaredServices(instance, substrate, host.registry, provided),
    roles: host.roles,
    mode: host.mode,
    rootDir: host.rootDir,
    lifecycle,
    routes: closingRoutes(instance.name, host.routes(instance), () => settingUp),
  });
  const setup = await loadSetup(instance);
  let result: unknown;
  try {
    result = await host.run(() => setup(context));
  } finally {
    settingUp = false;
  }
  const cleanup = typeof result === 'function' ? (result as PluginCleanup) : undefined;
  const missing = instance.provides.find((token) => !provided.has(token));
  if (missing === undefined) return cleanup;
  const error = new PluginErrors.Error('missing_provision', {
    plugin: instance.name,
    token: missing.name,
  });
  if (cleanup !== undefined) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'plugin setup failed', { cause: error });
    }
  }
  throw error;
}
