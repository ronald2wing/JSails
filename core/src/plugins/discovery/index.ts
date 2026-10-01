/**
 * Plugin package discovery (manifests only; no code execution).
 *
 * `discoverPlugins` lists the JSails plugin packages an application depends on
 * without importing any plugin code: each direct npm `dependencies` entry of the
 * app package that self-identifies through its own `package.json` `jsails`
 * field, then, transitively, each plugin package those depend on. A plugin's
 * own `dependencies` are resolved Node-style from the plugin's directory
 * (walking up toward `rootDir` but never beyond). The result is a sorted,
 * provenance-tagged plugin list, a list of non-fatal `issues`
 * (missing/unreadable/invalid manifests, a missing transitive dependency, a
 * dependency cycle, conflicting versions of one id), and the directed
 * plugin-to-plugin dependency `edges`. Two packages declaring one plugin id at
 * one version are a hard error (a thrown {@link PluginDiscoveryError}), never
 * silently dropped.
 *
 * Discovery activates nothing: a plugin runs only when the app config lists
 * it in `plugins.use`. It is what `jsails plugins list` and `check` report.
 * It is synchronous and filesystem-only: it reads `package.json` files through
 * an injectable fs facade and never evaluates a module.
 *
 * `discovery/scan.ts` owns the filesystem scanning/resolution and the result
 * model, `discovery/validate.ts` owns manifest validation, and
 * `discovery/dependencies.ts` owns the transitive walk, cycle detection, and
 * conflict reporting. This barrel owns the public surface and the orchestration.
 */

import { join } from 'node:path';

import {
  PluginDiscoveryError,
  defaultFs,
  discoverDirectDependencies,
  readAppPackage,
  type DiscoveredPlugin,
  type DiscoverPluginsOptions,
  type DiscoverPluginsResult,
  type PluginEdge,
  type PluginIssue,
} from './scan.js';
import {
  collectConflictingVersions,
  discoverTransitiveDependencies,
  edgeKey,
  finalizeDependencyPlugin,
  splitEdgeKey,
} from './dependencies.js';

export {
  PluginDiscoveryError,
  type DiscoveredPlugin,
  type DiscoverPluginsOptions,
  type DiscoverPluginsResult,
  type PluginDiscoveryErrorCode,
  type PluginEdge,
  type PluginFs,
  type PluginIssue,
} from './scan.js';

/**
 * Discover the plugin packages under `options.rootDir`, plus their
 * plugin-to-plugin dependency graph. See the module doc for the exact
 * semantics. Throws {@link PluginDiscoveryError} when two packages declare one
 * id at one version; everything else (missing/unreadable/invalid manifests, a
 * missing transitive dependency) is reported as an issue and the plugin is
 * omitted.
 */
export function discoverPlugins(options: DiscoverPluginsOptions): DiscoverPluginsResult {
  const fs = options.fs ?? defaultFs;
  const rootDir = options.rootDir;
  const packageJsonPath = options.packageJsonPath ?? join(rootDir, 'package.json');

  const appPackage = readAppPackage(fs, packageJsonPath);
  const issues: PluginIssue[] = [];

  const direct = discoverDirectDependencies(fs, rootDir, appPackage.dependencies, issues);
  const edges = new Set<string>();
  const transitive = discoverTransitiveDependencies(fs, rootDir, direct, issues, edges);

  // Declared plugin-to-plugin dependencies (`manifest.plugins`) are edges too,
  // distinct from npm package-level `dependencies`, so `check` can judge a
  // declared requirement against the discovered versions.
  for (const plugin of [...direct, ...transitive]) {
    for (const dependency of plugin.manifest.plugins ?? []) {
      edges.add(edgeKey(plugin.id, dependency.id));
    }
  }

  const plugins: DiscoveredPlugin[] = [
    ...direct.map(finalizeDependencyPlugin),
    ...transitive.map(finalizeDependencyPlugin),
  ];

  collectConflictingVersions(plugins, issues);
  assertUnique(plugins);

  return {
    plugins: sortPlugins(plugins),
    issues,
    edges: sortEdges(edges),
  };
}

/** Assert that no two packages declare one plugin id at one version. */
function assertUnique(plugins: readonly DiscoveredPlugin[]): void {
  const packages = new Map<string, string>();
  for (const plugin of plugins) {
    const key = `${plugin.id}\u0000${plugin.version}`;
    const existing = packages.get(key);
    if (existing !== undefined) {
      throw new PluginDiscoveryError(
        'duplicate_dependency_id',
        `plugin id "${plugin.id}" is declared by both "${existing}" and "${plugin.packageName}"`,
      );
    }
    packages.set(key, plugin.packageName);
  }
}

/** Sort edges by (from, to) for a deterministic result. */
function sortEdges(edges: ReadonlySet<string>): PluginEdge[] {
  return [...edges]
    .map(splitEdgeKey)
    .sort((a, b) =>
      a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
    );
}

/** Sort plugins by id, then version string. */
function sortPlugins(plugins: readonly DiscoveredPlugin[]): readonly DiscoveredPlugin[] {
  return [...plugins].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
  });
}
