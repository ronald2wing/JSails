/**
 * `definePlugin`: the plugin contract.
 *
 * A definition names the plugin, the schema of its options and of its
 * environment variables, the service tokens it requires, optionally reads and
 * provides, the substrate resources the kernel opens for it on first use, and
 * its setup (a function, or `lazy(() => import('./setup.js'))` so the module
 * a config imports stays light). `definePlugin` validates the definition once
 * and returns a factory; calling the factory parses the options (a failure is
 * `config.invalid_options`, raised before any setup can run) and returns an
 * inert {@link PluginInstance}.
 *
 * ```ts
 * export const searchPlugin: PluginFactory<SearchOptions> = definePlugin({
 *   name: 'search',
 *   options: z.object({ index: z.string(), store: tokenRef(diskToken) }).strict(),
 *   requires: (options) => [options.store],
 *   provides: [searchToken],
 *   setup({ options, services }) {
 *     services.provide(searchToken, createSearch(options.index, services.get(options.store)));
 *   },
 * });
 * ```
 *
 * Token declarations may depend on the parsed options, because keyed tokens
 * (one per configured disk) and `tokenRef` options decide them. The
 * definition records a literal list as frozen tokens and a computed one as
 * `undefined`, so tooling (the manifest agreement gate) reads the services a
 * plugin declares without configuring it whenever they are static. A plugin an
 * application may configure more than once (two disks) declares `key`, a
 * function of the parsed options naming the instance: each instance is then
 * `<name>:<key>`, so the runner's one-name-per-instance rule admits one
 * instance per key and still refuses the same key twice. The
 * contribution slots (`schema`, `jobs`, `schedules`, `release`) are lazy
 * modules too, read without setup by `loadPluginContribution`. This module
 * imports no schema library at runtime: the schemas arrive in the definition.
 */

import type { z } from 'zod';

import { isIdentifier } from '../../errors/context-schema.js';
import type { ErrorIssue } from '../../errors/kernel.js';
import { isRecord } from '../../json/shape.js';
import { isServiceToken, type ServiceToken } from '../../extensions/services.js';
import { mapZodIssues } from '../../validation/zod-issues.js';
import { describePluginEnv } from './env-variables.js';
import { ConfigErrors, PluginErrors } from './errors.js';
import {
  createPluginInstance,
  isLazyModule,
  PLUGIN_CONTRIBUTION_SLOTS,
  type LazyModule,
  type PluginContributions,
  type PluginContributionSlot,
  type PluginDefinition,
  type PluginEnvOf,
  type PluginEnvSchema,
  type PluginInstance,
  type PluginRuntimeDefinition,
  type PluginSetup,
  type SubstrateContext,
  type SubstrateResource,
} from './instance.js';
import { declaredPath } from './schema-def.js';

/**
 * The options a schema accepts, or `undefined` for a plugin without options.
 *
 * @public
 */
export type PluginOptionsInput<O> = O extends z.ZodType ? z.input<O> : undefined;

/**
 * The options a schema produces, or `undefined` for a plugin without options.
 *
 * @public
 */
export type PluginOptionsOutput<O> = O extends z.ZodType ? z.output<O> : undefined;

/**
 * A token list: fixed, or computed from the parsed options (an `undefined`
 * entry is dropped, so an unset `tokenRef` option needs no filtering).
 *
 * @public
 */
export type PluginTokenDeclaration<Options> =
  | readonly ServiceToken<unknown>[]
  | ((options: Options) => readonly (ServiceToken<unknown> | undefined)[]);

/**
 * What `definePlugin` takes.
 *
 * @public
 */
export interface PluginSpec<
  O extends z.ZodType | undefined = undefined,
  E extends PluginEnvSchema | undefined = undefined,
> {
  /** The plugin's name, an identifier; with `key`, the prefix of every instance's name. */
  readonly name: string;
  /** The options schema. Without one the factory takes no options. */
  readonly options?: O;
  /**
   * The key of one instance, from its parsed options (`({ disk }) => disk`):
   * the instance is named `<name>:<key>`, so the application can configure
   * the plugin once per key. `undefined` is the unkeyed instance. Without
   * `key` the plugin has one instance per application.
   */
  readonly key?: (options: PluginOptionsOutput<O>) => string | undefined;
  /** The environment variables it reads, built with `envVar.*`. */
  readonly env?: E;
  /** Services that must be provided before its setup runs. */
  readonly requires?: PluginTokenDeclaration<PluginOptionsOutput<O>>;
  /** Services it reads when another plugin provides them; ordered before it when present. */
  readonly optional?: PluginTokenDeclaration<PluginOptionsOutput<O>>;
  /** Services its setup provides; each one must be provided. */
  readonly provides?: PluginTokenDeclaration<PluginOptionsOutput<O>>;
  /** Resources the kernel opens on first use and closes at shutdown. Connection-free. */
  readonly substrate?: (
    context: SubstrateContext<PluginOptionsOutput<O>, PluginEnvOf<E>>,
  ) => readonly SubstrateResource<unknown>[];
  /** Wire its services: a function, or a lazily imported module whose default export is one. */
  readonly setup:
    | PluginSetup<PluginOptionsOutput<O>, PluginEnvOf<E>>
    | LazyModule<PluginSetup<PluginOptionsOutput<O>, PluginEnvOf<E>>>;
  /** The models, tables and data migrations it owns, read by the schema commands without setup. */
  readonly schema?: LazyModule<PluginContributions['schema']>;
  /** Its job definitions. */
  readonly jobs?: LazyModule<PluginContributions['jobs']>;
  /** Its schedules. */
  readonly schedules?: LazyModule<PluginContributions['schedules']>;
  /** Its release steps, run by the release command. */
  readonly release?: LazyModule<PluginContributions['release']>;
}

/**
 * The factory `definePlugin` returns: call it with the options to configure
 * one instance.
 *
 * @public
 */
export type PluginFactory<Input = undefined> = (undefined extends Input
  ? (options?: Input) => PluginInstance
  : (options: Input) => PluginInstance) & {
  /** The validated definition, readable without configuring an instance. */
  readonly definition: PluginDefinition;
};

const SPEC_FIELDS = new Set([
  'name',
  'options',
  'key',
  'env',
  'requires',
  'optional',
  'provides',
  'substrate',
  'setup',
  ...PLUGIN_CONTRIBUTION_SLOTS,
]);

function invalidOptions(plugin: string, issues: readonly ErrorIssue[]): Error {
  const first = issues[0];
  return new ConfigErrors.Error(
    'invalid_options',
    {
      plugin,
      problem: first !== undefined && isIdentifier(first.code) ? first.code : 'invalid',
      count: Math.max(issues.length, 1),
    },
    { payload: { issues: Object.freeze([...issues]) } },
  );
}

/**
 * Parse `input` against plugin `plugin`'s options schema. Throws
 * `config.invalid_options`; its payload lists each issue's path and rule,
 * and nothing in it repeats an input value: a path keeps only the keys the
 * schema declares and array indexes, so it stops before an unknown or record
 * key, and a message comes from the schema.
 *
 * @public
 */
export function parseOptions<S extends z.ZodType>(
  plugin: string,
  schema: S,
  input: unknown,
): z.output<S> {
  let result: ReturnType<S['safeParse']>;
  try {
    result = schema.safeParse(input) as ReturnType<S['safeParse']>;
  } catch {
    // A throwing refinement may carry the input in its error, so only the
    // fact that it threw is kept.
    throw invalidOptions(plugin, [{ path: [], code: 'invalid' }]);
  }
  if (result.success) return result.data as z.output<S>;
  throw invalidOptions(
    plugin,
    mapZodIssues(result.error).map((issue) =>
      Object.freeze({
        path: declaredPath(schema, issue.path),
        code: issue.code,
        message: issue.message,
      }),
    ),
  );
}

/** A plugin without an options schema takes nothing, or an empty object. */
function parseNoOptions(plugin: string, input: unknown): undefined {
  if (input === undefined) return undefined;
  if (isRecord(input)) {
    if (Object.keys(input).length === 0) return undefined;
    throw invalidOptions(plugin, [
      { path: [], code: 'unknown_field', message: 'this plugin takes no options' },
    ]);
  }
  throw invalidOptions(plugin, [
    { path: [], code: 'invalid_type', message: 'this plugin takes no options' },
  ]);
}

type TokenList = 'requires' | 'optional' | 'provides';

function isTokenDeclaration(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || Array.isArray(value);
}

function checkTokens(plugin: string, list: TokenList, tokens: readonly unknown[]): void {
  for (const token of tokens) {
    if (!isServiceToken(token)) throw new PluginErrors.Error('invalid_token', { plugin, list });
  }
}

function resolveTokens(
  plugin: string,
  list: TokenList,
  declaration: unknown,
  options: unknown,
): readonly ServiceToken<unknown>[] {
  if (declaration === undefined) return [];
  const declared: unknown =
    typeof declaration === 'function'
      ? (declaration as (options: unknown) => unknown)(options)
      : declaration;
  if (!Array.isArray(declared)) throw new PluginErrors.Error('invalid_token', { plugin, list });
  const tokens = declared.filter((token) => token !== undefined);
  checkTokens(plugin, list, tokens);
  return [...new Set(tokens as ServiceToken<unknown>[])];
}

/** The frozen, deduplicated tokens of a literal declaration; `undefined` when computed. */
function staticTokens(declaration: unknown): readonly ServiceToken<unknown>[] | undefined {
  if (declaration === undefined) return Object.freeze([]);
  if (!Array.isArray(declaration)) return undefined;
  return Object.freeze([...new Set(declaration as ServiceToken<unknown>[])]);
}

/**
 * The key `declaration` computes for `options`. It must be an identifier that
 * keeps the instance name `<plugin>:<key>` an identifier; the key itself is
 * never echoed, since options may come from input.
 */
function instanceKey(
  plugin: string,
  declaration: ((options: unknown) => unknown) | undefined,
  options: unknown,
): string | undefined {
  if (declaration === undefined) return undefined;
  const key = declaration(options);
  if (key === undefined) return undefined;
  if (!isIdentifier(key) || !isIdentifier(`${plugin}:${key}`)) {
    throw new PluginErrors.Error('invalid_instance_key', { plugin });
  }
  return key;
}

function invalidDefinition(
  plugin: string,
  problem:
    | 'unknown_field'
    | 'invalid_options_schema'
    | 'invalid_key'
    | 'invalid_token_list'
    | 'invalid_substrate'
    | 'invalid_setup'
    | 'invalid_contribution',
): Error {
  return new PluginErrors.Error('invalid_definition', { plugin, problem });
}

/**
 * Define a plugin. The definition is validated now (`plugin.*`); the returned
 * factory parses options when called (`config.invalid_options`) and returns
 * an inert instance.
 *
 * @public
 */
export function definePlugin<
  O extends z.ZodType | undefined = undefined,
  E extends PluginEnvSchema | undefined = undefined,
>(spec: PluginSpec<O, E>): PluginFactory<PluginOptionsInput<O>> {
  if (!isRecord(spec) || !isIdentifier(spec.name)) throw new PluginErrors.Error('invalid_name');
  const name = spec.name;
  if (Object.keys(spec).some((key) => !SPEC_FIELDS.has(key))) {
    throw invalidDefinition(name, 'unknown_field');
  }
  const options = spec.options;
  if (options !== undefined && (!isRecord(options) || typeof options.safeParse !== 'function')) {
    throw invalidDefinition(name, 'invalid_options_schema');
  }
  if (spec.key !== undefined && typeof spec.key !== 'function') {
    throw invalidDefinition(name, 'invalid_key');
  }
  const env = spec.env;
  if (env !== undefined) describePluginEnv(name, env);
  for (const list of ['requires', 'optional', 'provides'] as const) {
    const declaration: unknown = spec[list];
    if (!isTokenDeclaration(declaration)) throw invalidDefinition(name, 'invalid_token_list');
    if (Array.isArray(declaration)) checkTokens(name, list, declaration);
  }
  if (spec.substrate !== undefined && typeof spec.substrate !== 'function') {
    throw invalidDefinition(name, 'invalid_substrate');
  }
  if (typeof spec.setup !== 'function' && !isLazyModule(spec.setup)) {
    throw invalidDefinition(name, 'invalid_setup');
  }
  const contributions: Partial<Record<PluginContributionSlot, LazyModule<unknown>>> = {};
  for (const slot of PLUGIN_CONTRIBUTION_SLOTS) {
    const module: unknown = spec[slot];
    if (module === undefined) continue;
    if (!isLazyModule(module)) throw invalidDefinition(name, 'invalid_contribution');
    contributions[slot] = module;
  }

  const definition: PluginRuntimeDefinition = Object.freeze({
    name,
    keyed: spec.key !== undefined,
    options,
    env,
    providesServices: spec.provides !== undefined,
    requires: staticTokens(spec.requires),
    optional: staticTokens(spec.optional),
    provides: staticTokens(spec.provides),
    declaresSubstrate: spec.substrate !== undefined,
    contributes: Object.freeze(PLUGIN_CONTRIBUTION_SLOTS.filter((slot) => slot in contributions)),
    key: spec.key as PluginRuntimeDefinition['key'],
    substrate: spec.substrate as PluginRuntimeDefinition['substrate'],
    setup: spec.setup as PluginRuntimeDefinition['setup'],
    contributions: Object.freeze(contributions),
  });

  const factory = (input?: unknown): PluginInstance => {
    const parsed =
      options === undefined ? parseNoOptions(name, input) : parseOptions(name, options, input);
    const key = instanceKey(name, definition.key, parsed);
    const requires = resolveTokens(name, 'requires', spec.requires, parsed);
    const optional = resolveTokens(name, 'optional', spec.optional, parsed);
    const provides = resolveTokens(name, 'provides', spec.provides, parsed);
    for (const token of provides) {
      if (requires.includes(token) || optional.includes(token)) {
        throw new PluginErrors.Error('conflicting_token', { plugin: name, token: token.name });
      }
    }
    return createPluginInstance(definition, key, parsed, { requires, optional, provides });
  };
  Object.defineProperty(factory, 'definition', { value: definition, enumerable: true });
  return Object.freeze(factory) as unknown as PluginFactory<PluginOptionsInput<O>>;
}

/**
 * Whether `value` is a factory `definePlugin` returned.
 *
 * @public
 */
export function isPluginFactory(value: unknown): value is PluginFactory<unknown> {
  if (typeof value !== 'function') return false;
  const definition: unknown = (value as { readonly definition?: unknown }).definition;
  return (
    isRecord(definition) &&
    isIdentifier(definition['name']) &&
    typeof definition['providesServices'] === 'boolean'
  );
}
