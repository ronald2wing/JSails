/**
 * Stage 3 of the kernel pipeline: resolving a {@link LoadedApp} into a
 * {@link PluginGraph}, the plugins a process runs, in setup order.
 *
 * This is the only module that reads the sealed activation mode, and so the
 * only one that branches on it:
 *
 * - Locked (the default): the graph holds the framework plugins and the
 *   plugins the config declares, and no schema authority exists.
 * - Managed: the graph holds the same plugins and carries a
 *   {@link SchemaAuthority}. No plugin source exists yet, so nothing beyond
 *   the config activates code in either mode; the marketplace plugin source
 *   will add its verified plugins here, in managed mode only.
 *
 * The graph reports the declared plugins that only work in a live process
 * (`liveOnly`); a static export (the legacy `static` shape) leaves them out.
 *
 * The graph is validated from declarations alone, before any setup: two
 * plugins with one name, two instances providing one service, an instance
 * requiring a service no plugin could provide, and a requires cycle among
 * instances are each `config.misconfigured`. The extension runner repeats
 * its own checks when the graph runs.
 *
 * The entries are then put in setup order: topological over the contracts
 * and service tokens they declare (a provider before the plugins that
 * require or optionally read its service), the declared order breaking ties
 * (framework, `plugins.use`, `extensions`), as the runner orders
 * them (`orderExtensionEntries`).
 */

import { resolve as resolvePath } from 'node:path';

import type { ActivationMode, ResolvedAppConfig } from '../app/config/schema.js';
import { AppConfigError } from '../app/config/errors.js';
import { isIdentifier } from '../errors/context-schema.js';
import { orderExtensionEntries, type ExtensionEntry } from '../extensions/extension.js';
import type { ServiceToken } from '../extensions/services.js';
import { i18nPlugin, type I18nPluginOptions } from '../i18n/plugin.js';
import type { Messages } from '../i18n/translator.js';
import { pagesPlugin } from '../pages/plugin.js';
import { ConfigErrors } from '../plugins/contract/errors.js';
import {
  isPluginInstance,
  runtimeDefinitionOf,
  type PluginInstance,
} from '../plugins/contract/instance.js';
import type { PluginRole } from '../plugins/contract/lifecycle.js';
import { selectLiveOnly } from '../plugins/contract/liveness.js';
import { resolvePluginUse } from '../plugins/use.js';
import { routingPlugin } from '../routing/plugin.js';
import { sealedActivationMode } from './activation/mode.js';
import { mintSchemaAuthority, type SchemaAuthority } from './activation/schema-authority.js';
import { asLoadedApp, type LoadedApp } from './load-app.js';

/**
 * Where a graph entry came from.
 *
 * - `framework`: routing, pages, and i18n when the config states it.
 * - `config`: a `plugins.use` entry.
 * - `extension`: a legacy `extensions` entry.
 *
 * @public
 */
export type PluginGraphOrigin = 'framework' | 'config' | 'extension';

/**
 * One plugin of the graph.
 *
 * @public
 */
export interface PluginGraphNode {
  readonly name: string;
  readonly origin: PluginGraphOrigin;
}

/**
 * The plugins a process runs, validated, in setup order.
 *
 * @public
 */
export interface PluginGraph {
  /**
   * The plugins in setup order: each provider before the plugins that
   * require or optionally read its service, the declared order breaking ties.
   */
  readonly entries: readonly ExtensionEntry[];
  /** One node per entry, in the same order. */
  readonly nodes: readonly PluginGraphNode[];
  /**
   * The declared plugins that only work in a live process, in declared
   * order: each provides or requires a live service token, requires a token
   * that only live-only plugins provide, or is an extension whose
   * `describe()` says `needsLive`. A static export leaves them out of
   * `entries` and `nodes`; any other process runs them.
   */
  readonly liveOnly: readonly PluginGraphNode[];
  /** The roles the process runs; the runner sets up each plugin for them. */
  readonly roles: readonly PluginRole[];
  /** The activation mode the loader sealed. */
  readonly mode: ActivationMode;
  /** The schema authority, in managed mode outside safe mode; else `undefined`. */
  readonly schemaAuthority: SchemaAuthority | undefined;
}

/**
 * Options for {@link resolvePlugins}.
 *
 * @public
 */
export interface ResolvePluginsOptions {
  /**
   * The roles the process runs. Defaults to `['export']` for the legacy
   * `static` shape and `['web', 'worker']` otherwise.
   */
  readonly roles?: readonly PluginRole[];
  /**
   * Run only the plugins the config declares, whatever the mode: no schema
   * authority is minted. A static export and the schema commands resolve in
   * safe mode.
   */
  readonly safeMode?: boolean;
}

/**
 * The activation mode sealed on `app`: a read-only fact for code that must
 * report or explain it without resolving the graph. Nothing can change it.
 *
 * @public
 */
export function activationModeOf(app: LoadedApp): ActivationMode {
  return sealedActivationMode(app);
}

/**
 * Resolve `app` into its {@link PluginGraph}. A plain resolved config is taken
 * as a locked app.
 *
 * @public
 */
export async function resolvePlugins(
  source: LoadedApp | ResolvedAppConfig,
  options: ResolvePluginsOptions = {},
): Promise<PluginGraph> {
  const app = asLoadedApp(source);
  const { config } = app;
  const mode = sealedActivationMode(app);
  const exporting = isStatic(config);
  const managed = mode === 'managed' && options.safeMode !== true && !exporting;
  const roles: readonly PluginRole[] =
    options.roles ?? (exporting ? ['export'] : ['web', 'worker']);

  const framework = frameworkPlugins(config);
  const declared = await resolveDeclared(config);
  const tagged: { readonly entry: ExtensionEntry; readonly origin: PluginGraphOrigin }[] = [
    ...framework.map((entry) => ({ entry, origin: 'framework' as const })),
    ...declared.map((entry) => ({ entry, origin: 'config' as const })),
    ...config.extensions.map((entry) => ({ entry, origin: 'extension' as const })),
  ];

  // The live-only set is taken over every declared plugin, so a `plugins.use`
  // consumer stranded by a live provider is in it whatever list declared
  // either; a static export then excludes the whole set.
  const liveOnly = new Set(selectLiveOnly(tagged.map(({ entry }) => entry)));
  const kept = exporting ? tagged.filter(({ entry }) => !liveOnly.has(entry)) : tagged;
  validateGraph(kept.map(({ entry }) => entry));
  const origins = new Map(kept.map(({ entry, origin }) => [entry, origin] as const));
  const entries = orderExtensionEntries(kept.map(({ entry }) => entry));

  return Object.freeze({
    entries: Object.freeze([...entries]),
    nodes: Object.freeze(
      entries.map((entry) =>
        Object.freeze({ name: entry.name, origin: origins.get(entry) as PluginGraphOrigin }),
      ),
    ),
    liveOnly: Object.freeze(
      tagged
        .filter(({ entry }) => liveOnly.has(entry))
        .map(({ entry, origin }) => Object.freeze({ name: entry.name, origin })),
    ),
    roles: Object.freeze([...roles]),
    mode,
    schemaAuthority: managed ? mintSchemaAuthority() : undefined,
  });
}

/** Whether the app is a static export (the legacy `static` shape). */
function isStatic(config: ResolvedAppConfig): boolean {
  return (config.shape ?? 'full') === 'static';
}

/**
 * The framework plugins: routing first so every app gets filesystem route
 * discovery, pages second for the default renderer and static-site
 * generator, then i18n when the legacy `i18n` key configures it.
 */
function frameworkPlugins(config: ResolvedAppConfig): readonly ExtensionEntry[] {
  const plugins: ExtensionEntry[] = [
    routingPlugin({ pagesDir: config.pagesDir, apiDir: config.apiDir }),
    pagesPlugin(),
  ];
  if (config.i18n !== undefined) {
    const resolved = config.i18n;
    const options: I18nPluginOptions = {
      locale: resolved.locale,
      fallbackLocale: resolved.fallbackLocale,
      catalogs: resolved.catalogs as Record<string, Messages> | undefined,
      loadPaths: resolved.loadPaths?.map((path) => resolvePath(config.rootDir, path)),
    };
    plugins.push(i18nPlugin(options));
  }
  return plugins;
}

/**
 * Resolve the `plugins.use` entries. An entry that fails to load is a fatal
 * boot error: the developer asked for it, so a missing or broken plugin is a
 * misconfiguration, not a warning.
 */
async function resolveDeclared(config: ResolvedAppConfig): Promise<readonly ExtensionEntry[]> {
  if (config.plugins.use.length === 0) return [];
  const result = await resolvePluginUse({ entries: config.plugins.use });
  if (result.issues.length > 0) {
    // The specifier is the value the developer wrote in their config, not a
    // secret: it is the actionable identifier. Options and error details are
    // never echoed.
    const specifiers = result.issues.map((issue) => issue.path ?? 'unknown').join(', ');
    throw new AppConfigError(`plugin(s) failed to load: ${specifiers}`);
  }
  return result.plugins;
}

/**
 * Validate the graph from declarations alone, before any setup:
 *
 * - every entry name is unique;
 * - no two instances declare the same provided service;
 * - every service an instance requires is provided by an instance, or could
 *   be: by a legacy extension (which registers its services at setup) or by
 *   an instance's substrate (declared from its environment at run time);
 * - the requires edges among instances have no cycle.
 */
function validateGraph(entries: readonly ExtensionEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) misconfigured('duplicate_name', entry.name);
    names.add(entry.name);
  }
  const instances = entries.filter(isPluginInstance);
  const providers = new Map<ServiceToken<unknown>, PluginInstance>();
  for (const instance of instances) {
    for (const token of instance.provides) {
      if (providers.has(token)) misconfigured('duplicate_provider', instance.name);
      providers.set(token, instance);
    }
  }
  const openProviders =
    instances.length !== entries.length ||
    instances.some((instance) => runtimeDefinitionOf(instance).declaresSubstrate);
  if (!openProviders) {
    for (const instance of instances) {
      for (const token of instance.requires) {
        if (!providers.has(token)) misconfigured('unsatisfied_service', instance.name);
      }
    }
  }
  assertAcyclic(instances, providers);
}

/** Depth-first search over the instance requires edges; a back edge is a cycle. */
function assertAcyclic(
  instances: readonly PluginInstance[],
  providers: ReadonlyMap<ServiceToken<unknown>, PluginInstance>,
): void {
  const state = new Map<PluginInstance, 'visiting' | 'done'>();
  const visit = (instance: PluginInstance): void => {
    const seen = state.get(instance);
    if (seen === 'done') return;
    if (seen === 'visiting') misconfigured('dependency_cycle', instance.name);
    state.set(instance, 'visiting');
    for (const token of [...instance.requires, ...instance.optional]) {
      const provider = providers.get(token);
      if (provider !== undefined && provider !== instance) visit(provider);
    }
    state.set(instance, 'done');
  };
  for (const instance of instances) visit(instance);
}

function misconfigured(
  problem: 'dependency_cycle' | 'unsatisfied_service' | 'duplicate_name' | 'duplicate_provider',
  plugin: string,
): never {
  throw new ConfigErrors.Error('misconfigured', { problem, plugin: identifierOf(plugin) });
}

/** A plugin name as an identifier context value; a legacy name that is not one is withheld. */
function identifierOf(name: string): string {
  return isIdentifier(name) ? name : '_';
}
