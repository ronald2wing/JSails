/**
 * `defineApp`: the default export of an app's `jsails.config.ts`.
 *
 * A definition holds an optional environment declaration and a `config`
 * function. The declaration has the shape a plugin's `env` has: one schema
 * per variable, usually built with `envVar`. The loader parses the
 * environment it is handed against it, then calls `config` with the parsed
 * values. That is the only way the environment reaches the config. It cannot
 * reach `plugins.activation`, which must be a literal (see the loader's
 * static scan).
 *
 * The definition is branded, so the loader can tell a real definition from an
 * object that only looks like one. This module has no runtime imports, so
 * the config root loads nothing heavier than `jsails/kernel`.
 */

import type { JsailsAppConfig } from '../app/config/schema.js';
import type { PluginEnvOf, PluginEnvSchema } from '../plugins/contract/instance.js';

/**
 * `C` with every key `JsailsAppConfig` does not have typed `never`, so an
 * unknown top-level key in a config function's result is a compile error.
 * TypeScript does not check a function's returned object literal for excess
 * properties, so the check is spelled out. Nested blocks are checked by the
 * strict schema at load.
 *
 * @public
 */
export type ExactAppConfig<C> = C & {
  readonly [K in Exclude<keyof C, keyof JsailsAppConfig>]: never;
};

/**
 * What `defineApp` takes.
 *
 * @public
 */
export interface AppDefinitionInput<
  E extends PluginEnvSchema | undefined,
  C extends JsailsAppConfig,
> {
  /** The variables the config reads, one schema each, parsed from the environment the loader is handed. */
  readonly env?: E;
  /** Build the app config from the parsed variables. Called once, at load. */
  readonly config: (env: PluginEnvOf<E>) => ExactAppConfig<C>;
}

/**
 * A branded app definition, made by {@link defineApp}.
 *
 * @public
 */
export interface AppDefinition {
  readonly env: PluginEnvSchema | undefined;
  readonly config: (env: Readonly<Record<string, unknown>>) => JsailsAppConfig;
}

const DEFINITIONS = new WeakSet<object>();

/**
 * Define an app: the variables it reads and its config function.
 *
 * @example
 * ```ts
 * import { defineApp, envVar } from 'jsails/kernel';
 *
 * export default defineApp({
 *   env: { PUBLIC_ORIGIN: envVar.url() },
 *   config: (env) => ({ server: { origin: env.PUBLIC_ORIGIN } }),
 * });
 * ```
 *
 * @public
 */
export function defineApp<
  const E extends PluginEnvSchema | undefined = undefined,
  C extends JsailsAppConfig = JsailsAppConfig,
>(definition: AppDefinitionInput<E, C>): AppDefinition {
  const app: AppDefinition = Object.freeze({
    env: definition.env,
    config: definition.config as unknown as AppDefinition['config'],
  });
  DEFINITIONS.add(app);
  return app;
}

/**
 * Whether `value` is a definition {@link defineApp} made.
 *
 * @public
 */
export function isAppDefinition(value: unknown): value is AppDefinition {
  return typeof value === 'object' && value !== null && DEFINITIONS.has(value);
}
