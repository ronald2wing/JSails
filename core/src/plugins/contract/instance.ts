/**
 * The runtime shapes of the plugin contract: a plugin definition, the
 * instance its factory returns for one set of options, the setup context, and
 * the lazily loaded module values.
 *
 * Kept free of a runtime Zod import, so the extension runner and the testing
 * harness, which recognise and run instances, load no schema library; the
 * schemas themselves arrive inside the definitions.
 */

import type { z } from 'zod';

import type { Awaitable } from '../../contracts/awaitable.js';
import type { ServiceToken } from '../../extensions/services.js';
import type { HttpRoutes } from '../../server/http-routes.js';
import type { PluginLifecycle, PluginRole } from './lifecycle.js';

/**
 * The brand of a {@link LazyModule}; `Symbol.for`, so a module made by one
 * copy of the framework is recognised by another in the same process.
 */
const LAZY_MODULE: unique symbol = Symbol.for('jsails.lazy-module');

/**
 * The brand of a {@link PluginInstance}, carrying its definition.
 */
const PLUGIN_INSTANCE: unique symbol = Symbol.for('jsails.plugin-instance');

/**
 * A module loaded on first use: the setup of a plugin whose config entry must
 * stay light, or a module an option names.
 *
 * @public
 */
export interface LazyModule<T> {
  readonly [LAZY_MODULE]: true;
  /** Import the module; its default export is the value. */
  load(): Promise<{ readonly default: T }>;
}

/**
 * Wrap a dynamic import as a {@link LazyModule}:
 * `lazy(() => import('./setup.js'))`. Nothing is imported until `load` runs.
 *
 * @public
 */
export function lazy<T>(load: () => Promise<{ readonly default: T }>): LazyModule<T> {
  return Object.freeze({ [LAZY_MODULE]: true as const, load: () => load() });
}

/**
 * Whether `value` is a {@link LazyModule}.
 *
 * @public
 */
export function isLazyModule(value: unknown): value is LazyModule<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<PropertyKey, unknown>)[LAZY_MODULE] === true &&
    typeof (value as { readonly load?: unknown }).load === 'function'
  );
}

/**
 * A plugin's environment declaration: variable name to the schema an
 * `envVar.*` helper built.
 *
 * @public
 */
export type PluginEnvSchema = Readonly<Record<string, z.ZodType<unknown, string | undefined>>>;

/**
 * The parsed environment a {@link PluginEnvSchema} describes.
 *
 * @public
 */
export type PluginEnvOf<E> = E extends PluginEnvSchema
  ? { readonly [K in keyof E]: z.output<E[K]> }
  : Readonly<Record<never, never>>;

/**
 * The services a plugin's setup reads and provides. Every token must be one
 * the definition declares (`requires`, `optional`, `provides`, or its own
 * substrate); `provide` takes only a declared `provides` token.
 *
 * @public
 */
export interface PluginServices {
  /** Whether `token` is registered. */
  has<T>(token: ServiceToken<T>): boolean;
  /** The service under `token`, or `undefined`. */
  tryGet<T>(token: ServiceToken<T>): T | undefined;
  /** The service under `token`; `service.not_found` when absent. */
  get<T>(token: ServiceToken<T>): T;
  /** Register `value` under a declared `provides` token. */
  provide<T>(token: ServiceToken<T>, value: T): void;
}

/**
 * The mode a process runs in: the `NODE_ENV` the environment resolver derives
 * from the environment name. `development` and `test` are themselves; every
 * other value, unset included, is `production`, so a plugin that relaxes a
 * rule outside production fails closed.
 *
 * @public
 */
export type PluginMode = 'development' | 'test' | 'production';

/**
 * What a plugin's setup receives.
 *
 * @public
 */
export interface PluginSetupContext<Options = unknown, Env = Readonly<Record<never, never>>> {
  /** The instance's name: the plugin's name, or `<name>:<key>` for a keyed instance. */
  readonly name: string;
  /** The instance key its options chose; `undefined` for an unkeyed instance. */
  readonly key: string | undefined;
  /** The options its factory parsed. */
  readonly options: Options;
  /** Its validated environment variables. */
  readonly env: Env;
  /** Declared services: read dependencies, provide its own. */
  readonly services: PluginServices;
  /** The roles the process runs. */
  readonly roles: ReadonlySet<PluginRole>;
  /** The mode the process runs in. */
  readonly mode: PluginMode;
  /** The absolute application root; project files resolve against it. */
  readonly rootDir: string;
  /** Long-running work, started by the host rather than by setup. */
  readonly lifecycle: PluginLifecycle;
  /**
   * The instance's HTTP registrar (owner: its name): routes with a required
   * `access`, and, as the host grants, fetch-handler mounts, guards and
   * response transforms. Valid only while setup runs; nothing is wired until
   * the application is assembled.
   */
  readonly routes: HttpRoutes;
}

/**
 * Teardown a setup returns, run in reverse order on shutdown.
 *
 * @public
 */
export type PluginCleanup = () => Awaitable<void>;

/**
 * A plugin's setup: connection-free wiring of its services.
 *
 * @public
 */
export type PluginSetup<Options = unknown, Env = Readonly<Record<never, never>>> = (
  context: PluginSetupContext<Options, Env>,
) => Awaitable<void | PluginCleanup>;

/**
 * A resource the kernel opens on first use and closes once at shutdown (a
 * connection pool, a client): declared by the plugin, registered under
 * `token` as a lazy handle before any setup runs.
 *
 * @public
 */
export interface SubstrateResource<T> {
  readonly token: ServiceToken<SubstrateHandle<T>>;
  /** Open the resource; runs on the first `get`. */
  create(): Awaitable<T>;
  /** Release a resource `create` returned; runs at most once. */
  close(resource: T): Awaitable<void>;
}

/**
 * The handle registered for a {@link SubstrateResource}.
 *
 * @public
 */
export interface SubstrateHandle<T> {
  /** Whether the kernel has closed the resource. */
  readonly closed: boolean;
  /** The resource, opened on the first call. */
  get(): Promise<T>;
}

/**
 * What a plugin's `substrate` declaration receives.
 *
 * @public
 */
export interface SubstrateContext<Options = unknown, Env = Readonly<Record<never, never>>> {
  readonly options: Options;
  readonly env: Env;
  /** The absolute application root, as setup receives it: a resource's relative paths resolve against it. */
  readonly rootDir: string;
}

/**
 * What a plugin contributes to the application besides its services, read
 * without running its setup: the tables and models it owns (`schema`), its
 * job definitions, its schedules and its release steps. The kernel carries
 * each slot as a lazily loaded module; the package that reads a slot (the
 * database for `schema`, the jobs package for `jobs` and `schedules`, the
 * release command for `release`) defines and validates its elements.
 *
 * @public
 */
export type PluginContributionSlot = 'schema' | 'jobs' | 'schedules' | 'release';

/**
 * Every contribution slot, in a stable order.
 *
 * @public
 */
export const PLUGIN_CONTRIBUTION_SLOTS: readonly PluginContributionSlot[] = Object.freeze([
  'schema',
  'jobs',
  'schedules',
  'release',
]);

/**
 * A model class a plugin owns: a class `defineModel` registered.
 *
 * @public
 */
export type PluginModel = abstract new (...args: never[]) => object;

/**
 * The `schema` contribution: the model classes, tables and data migrations a
 * plugin owns. `db:push`, `db:diff` and `jsails test` register its models
 * beside the application's; table specs and data migrations are the phased
 * schema planner's shapes, and the schema commands refuse a contribution
 * that carries any until that planner reads them.
 *
 * @public
 */
export interface PluginSchemaContribution {
  readonly models?: readonly PluginModel[];
  readonly tables?: readonly object[];
  readonly dataMigrations?: readonly object[];
}

/**
 * The value each contribution slot's module default-exports.
 *
 * @public
 */
export interface PluginContributions {
  readonly schema: PluginSchemaContribution;
  readonly jobs: readonly object[];
  readonly schedules: readonly object[];
  readonly release: readonly object[];
}

/**
 * A plugin definition as `definePlugin` validated it. Tools read it without
 * running anything: the agreement gate compares it with the package manifest.
 *
 * @public
 */
export interface PluginDefinition {
  readonly name: string;
  /** Whether the definition keys its instances, so one application can configure several. */
  readonly keyed: boolean;
  /** The options schema; `undefined` when the plugin takes no options. */
  readonly options: z.ZodType | undefined;
  /** The environment declaration; `undefined` when it reads none. */
  readonly env: PluginEnvSchema | undefined;
  /** Whether the definition declares provided services. */
  readonly providesServices: boolean;
  /**
   * The services a literal `requires` list names, frozen; `undefined` when the
   * list is computed from the options, so only an instance knows it.
   */
  readonly requires: readonly ServiceToken<unknown>[] | undefined;
  /** The services a literal `optional` list names; `undefined` when computed. */
  readonly optional: readonly ServiceToken<unknown>[] | undefined;
  /** The services a literal `provides` list names; `undefined` when computed. */
  readonly provides: readonly ServiceToken<unknown>[] | undefined;
  /** Whether the definition declares substrate resources. */
  readonly declaresSubstrate: boolean;
  /** The contribution slots the definition fills, in {@link PLUGIN_CONTRIBUTION_SLOTS} order. */
  readonly contributes: readonly PluginContributionSlot[];
}

/**
 * The parts of a definition only the runner, the harness and the
 * contribution reader use.
 */
export interface PluginRuntimeDefinition extends PluginDefinition {
  readonly key: ((options: unknown) => unknown) | undefined;
  readonly substrate:
    ((context: SubstrateContext) => readonly SubstrateResource<unknown>[]) | undefined;
  readonly setup: PluginSetup | LazyModule<PluginSetup>;
  readonly contributions: Readonly<Partial<Record<PluginContributionSlot, LazyModule<unknown>>>>;
}

/**
 * One configured plugin: its definition, its parsed options, and the tokens
 * it requires, optionally reads and provides for those options. Inert until a
 * host runs it.
 *
 * Its `name` is unique within an application. A plugin that declares `key`
 * names each instance `<plugin>:<key>` (the key its options chose), so one
 * application can configure it once per key, each instance providing its own
 * keyed tokens; an unkeyed instance carries the plugin's name.
 *
 * @public
 */
export interface PluginInstance {
  readonly [PLUGIN_INSTANCE]: PluginDefinition;
  readonly name: string;
  /** The instance key; `undefined` for an unkeyed instance. */
  readonly key: string | undefined;
  readonly options: unknown;
  readonly requires: readonly ServiceToken<unknown>[];
  readonly optional: readonly ServiceToken<unknown>[];
  readonly provides: readonly ServiceToken<unknown>[];
}

/**
 * Whether `value` is a {@link PluginInstance}.
 *
 * @public
 */
export function isPluginInstance(value: unknown): value is PluginInstance {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<PropertyKey, unknown>)[PLUGIN_INSTANCE] === 'object'
  );
}

/** The full definition behind an instance. */
export function runtimeDefinitionOf(instance: PluginInstance): PluginRuntimeDefinition {
  return instance[PLUGIN_INSTANCE] as PluginRuntimeDefinition;
}

/** Build a frozen instance; only `definePlugin` calls it, with a checked key. */
export function createPluginInstance(
  definition: PluginRuntimeDefinition,
  key: string | undefined,
  options: unknown,
  tokens: {
    readonly requires: readonly ServiceToken<unknown>[];
    readonly optional: readonly ServiceToken<unknown>[];
    readonly provides: readonly ServiceToken<unknown>[];
  },
): PluginInstance {
  return Object.freeze({
    [PLUGIN_INSTANCE]: definition,
    name: key === undefined ? definition.name : `${definition.name}:${key}`,
    key,
    options,
    requires: Object.freeze([...tokens.requires]),
    optional: Object.freeze([...tokens.optional]),
    provides: Object.freeze([...tokens.provides]),
  });
}
