/**
 * Declarative plugin DSL: a thin data-to-imperative adapter over
 * {@link definePlugin} and the {@link PluginContext} contract.
 *
 * `defineDeclarativePlugin(spec)` turns a declaration into a working
 * {@link JsailsPlugin} whose `setup` auto-registers the declared `provide`
 * entries, hands the plugin's HTTP registrar ({@link PluginContext.routes}) to
 * the `routes` callback, and then runs the optional `setup` callback. It never reimplements the
 * extension runner — it reshapes a declarative object into the imperative
 * contract the runner already consumes.
 *
 * ```ts
 * const plugin = defineDeclarativePlugin({
 *   name: 'clock',
 *   provide: [[clockToken, { now: () => new Date().toISOString() }]],
 *   routes: (routes) =>
 *     routes.add({
 *       methods: ['GET'],
 *       path: '/time',
 *       access: publicAccess('the server clock'),
 *       handler: () => Respond.json({ now: new Date().toISOString() }),
 *     }),
 * });
 * ```
 *
 * `provide` entries are `[token, value]` tuples — the token is the opaque
 * {@link ServiceToken} object (created by {@link createServiceToken}), not a
 * name string. Passing a non-token key throws the value-free
 * `declarative_plugin.invalid_provide_key`.
 */

import type { ExtensionCleanup } from './extension.js';
import type { JsailsPlugin, PluginContext, PluginDescription } from './plugin-contract.js';
import type { ServiceToken } from './services.js';
import type { ContractToken } from './contracts.js';
import type { PageRenderer } from '../contracts/render.js';
import type { HttpRoutes } from '../server/http-routes.js';
import { isTokenLike } from './validation.js';
import { isIdentifier } from '../errors/context-schema.js';
import { defineErrors, invariant, type ErrorRegistry } from '../errors/registry.js';
import type { Awaitable } from '../contracts/awaitable.js';

// Re-exported for consumer convenience — the core type lives in plugin-contract.js.
export type { JsailsPlugin };

const DECLARATIVE_PLUGIN_ERRORS = {
  invalid_name: {
    kind: 'internal',
    message: 'a plugin name must be an identifier',
  },
  invalid_provide_entry: {
    kind: 'internal',
    message: 'plugin {plugin} has a provide entry that is not a [token, value] pair',
    context: { plugin: 'identifier' },
  },
  invalid_provide_key: {
    kind: 'internal',
    message: 'plugin {plugin} has a provide entry whose key is not a service token',
    context: { plugin: 'identifier' },
    suggestion: 'create provide keys with createServiceToken',
  },
  invalid_routes: {
    kind: 'internal',
    message: 'plugin {plugin} has a routes entry that is not a function',
    context: { plugin: 'identifier' },
    suggestion: 'routes is a function receiving the plugin registrar: (routes) => routes.add(...)',
  },
  removed_option: {
    kind: 'internal',
    message: 'plugin {plugin} declares the removed {option} option; declare {replacement} instead',
    context: { plugin: 'identifier', option: ['http'], replacement: ['routes'] },
    suggestion: 'routes is a function receiving the plugin registrar: (routes) => routes.add(...)',
  },
  unknown_option: {
    kind: 'internal',
    message: 'plugin {plugin} declares an option the declarative plugin spec does not have',
    context: { plugin: 'identifier' },
    suggestion:
      'declare only name, requires, provide, routes, setup, describe, renderer, priority and disabled',
  },
} as const;

/**
 * The declarative plugin's codes, `declarative_plugin.*`. The context names the
 * plugin, never a provided value, key or token.
 *
 * @public
 */
export const DeclarativePluginErrors: ErrorRegistry<
  'declarative_plugin',
  typeof DECLARATIVE_PLUGIN_ERRORS
> = defineErrors('declarative_plugin', DECLARATIVE_PLUGIN_ERRORS);

/** The declarative input shape. Everything except `name` is optional. */
export interface DeclarativePluginSpec {
  /** Unique plugin name, an identifier. */
  readonly name: string;
  /** Tokens this plugin requires before its setup runs. */
  readonly requires?: readonly (ServiceToken<unknown> | ContractToken<unknown>)[];
  /** Token → value pairs registered via {@link PluginContext.services}.provide. */
  readonly provide?: Iterable<readonly [ServiceToken<unknown>, unknown]>;
  /**
   * Registers the plugin's HTTP surface on its registrar
   * ({@link PluginContext.routes}): every route states its access.
   */
  readonly routes?: (routes: HttpRoutes) => void;
  /**
   * Optional extra setup logic. Runs after `provide` and `routes` are wired.
   * Receives the full {@link PluginContext} so the caller can register
   * interceptors, observers, request scopes, guards, or serve hooks.
   */
  readonly setup?: (context: PluginContext) => Awaitable<void | ExtensionCleanup>;
  /** Optional static descriptor (see {@link JsailsPlugin.describe}). */
  readonly describe?: () => PluginDescription;
  /** Page renderer carried through by identity. */
  readonly renderer?: PageRenderer;
  /** Ordering key; see {@link JsailsPlugin.priority}. */
  readonly priority?: number;
  /** When `true`, the plugin is filtered out before setup. */
  readonly disabled?: boolean;
}

/**
 * Every key a spec may declare. A key the spec does not have would otherwise
 * be dropped without a word (a plain `.js` config escapes the excess-property
 * check), so its plugin would boot without the behaviour it declares.
 */
const SPEC_KEYS: Readonly<Record<keyof DeclarativePluginSpec, true>> = {
  name: true,
  requires: true,
  provide: true,
  routes: true,
  setup: true,
  describe: true,
  renderer: true,
  priority: true,
  disabled: true,
};

/** Removed spec keys, each with the key that replaces it. */
const REMOVED_SPEC_KEYS = { http: 'routes' } as const;

/** Refuse a removed or unknown spec key; the error names the plugin, never the key. */
function assertSpecKeys(spec: DeclarativePluginSpec): void {
  for (const key of Object.keys(spec)) {
    if (Object.hasOwn(REMOVED_SPEC_KEYS, key)) {
      const option = key as keyof typeof REMOVED_SPEC_KEYS;
      throw new DeclarativePluginErrors.Error('removed_option', {
        plugin: spec.name,
        option,
        replacement: REMOVED_SPEC_KEYS[option],
      });
    }
    if (!Object.hasOwn(SPEC_KEYS, key)) {
      throw new DeclarativePluginErrors.Error('unknown_option', { plugin: spec.name });
    }
  }
}

/**
 * Turn a declarative spec into a working {@link JsailsPlugin} whose `setup`
 * automatically registers `provide` entries, runs the `routes` callback, and then
 * delegates to the optional `setup` callback.
 *
 * Validation happens eagerly (an invalid `name`, `provide` entry or `routes`
 * value, the removed `http` hook, or a key the spec does not have throws a
 * `declarative_plugin.*` error) so a broken plugin is caught before any setup
 * runs.
 */
export function defineDeclarativePlugin(spec: DeclarativePluginSpec): JsailsPlugin {
  const { name } = spec;
  invariant(isIdentifier(name), DeclarativePluginErrors, 'invalid_name');
  assertSpecKeys(spec);

  const provideEntries: readonly (readonly [ServiceToken<unknown>, unknown])[] | undefined =
    spec.provide === undefined ? undefined : [...spec.provide];

  // Eager validation: every provide entry must be a [token, value] pair with a
  // token-like key (runtime structural check — the compile-time brand can't be
  // inspected, but a non-object-or-array key with a string `name` is rejected).
  if (provideEntries !== undefined) {
    for (const entry of provideEntries) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new DeclarativePluginErrors.Error('invalid_provide_entry', { plugin: name });
      }
      const [token] = entry;
      if (!isTokenLike(token)) {
        throw new DeclarativePluginErrors.Error('invalid_provide_key', { plugin: name });
      }
    }
  }

  const { requires, routes, setup: userSetup, describe, renderer, priority, disabled } = spec;
  if (routes !== undefined && typeof routes !== 'function') {
    throw new DeclarativePluginErrors.Error('invalid_routes', { plugin: name });
  }

  return Object.freeze({
    name,
    requires,
    renderer,
    describe,
    priority,
    disabled,
    setup(context: PluginContext): Awaitable<void | ExtensionCleanup> {
      if (provideEntries !== undefined) {
        for (const [token, value] of provideEntries) {
          context.services.provide(token, value);
        }
      }

      if (routes !== undefined) {
        routes(context.routes);
      }

      if (userSetup !== undefined) {
        return userSetup(context);
      }
    },
  });
}
