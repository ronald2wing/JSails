/**
 * Plugin activation: turn discovery + enablement into loaded plugin objects.
 *
 * `activatePlugins` is the step that imports plugin code. It folds enablement
 * and discovery together: it resolves which plugin ids are enabled through
 * {@link loadPluginEnablement} (the managed/non-managed switch — a non-managed
 * deployment performs **zero** state-source I/O), passes that list to
 * {@link discoverPlugins} as the `enabled` allowlist so discovery and
 * activation agree on exactly which plugins are active, then, for each active
 * discovered plugin, resolves its entry module and dynamically imports it.
 *
 * Importing a plugin module **executes trusted plugin code**: a plugin's
 * top-level module body runs at import time. The plugin's `setup` is **not**
 * called here — activation only loads and structurally validates the exported
 * object(s); {@link runExtensions} (or `createApplication`) runs `setup` later,
 * in priority order, against a per-application service registry.
 *
 * Only one version of each bundle is loaded: the version recorded as `active`
 * in managed state (older versions stay on disk for rollback, and a rollback
 * must actually stop the version it rolled away from). A bundle id with no
 * recorded active version and several installed versions loads none.
 *
 * Every activated plugin is wrapped by {@link gatePluginCapabilities}: a setup
 * capability (routes, middleware, serve hooks, interceptors, observers, service
 * replacement) its manifest `permissions` do not declare is refused.
 *
 * A plugin module's default export must be a {@link JsailsPlugin} or an array of
 * them (validated structurally: an object with a non-empty string `name` and a
 * function `setup`). The array is flattened and each entry is validated; a
 * module may instead carry the array under a `plugins` named export, which is
 * accepted when the default export is absent. The default export takes
 * precedence when both are present — that choice is reported here by convention,
 * not by any result field. A failed import or an invalid export yields a
 * `plugin_load_failed` issue (value-free; module contents and error messages
 * are never echoed, only a Node error code or built-in error name in `detail`)
 * and that plugin is skipped without aborting the rest. An autoload specifier
 * that fails to import is an `autoload_failed` issue for that plugin only. The result is deterministic:
 * plugins are ordered by id, and duplicates across sources already error during
 * discovery.
 *
 * ## Entry resolution
 *
 * A bundle's manifest `entry` is a portable path relative to its bundle
 * directory (`./index.js` and `index.js` are the same file) and must stay
 * inside it. A dependency plugin's `entry` is a relative path inside its
 * package directory, or a bare specifier naming its own package (or one of its
 * subpaths), resolved from the package's location so a non-hoisted install
 * finds the right copy. A URL-scheme specifier (`node:`, `data:`, `file:`, …),
 * an absolute path, or an entry that escapes its directory is an
 * `invalid_entry` issue. {@link isBareSpecifier} distinguishes bare from path
 * forms.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertPortablePath } from '../deploy/portable-path.js';
import { gatePluginCapabilities } from './capability-gate.js';

import { isJsailsPlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import {
  discoverPlugins,
  type DiscoveredPlugin,
  type PluginIssue,
  type SkippedPlugin,
} from './discovery/index.js';
import { loadPluginEnablementState } from './database-state-store.js';
import type { PluginStateSource } from './state-store.js';
import { resolveAutoloadExposure, type InstalledPlugin } from '../symbols/autoload-resolution.js';
import {
  installPluginGlobals,
  type PluginAutoloadEntry,
} from '../symbols/install-plugin-globals.js';

/** Inputs to {@link activatePlugins}. */
export interface ActivatePluginsInput {
  /** Project root; `node_modules` and the plugins folder resolve under it. */
  readonly rootDir: string;
  /** Plugin ids enabled in the app config (`plugins.enabled`). */
  readonly codeEnabled?: readonly string[];
  /** Whether plugin state is managed in the database. Defaults to `false`. */
  readonly managed?: boolean;
  /** The state source for a managed deployment. Required when `managed` is true. */
  readonly stateSource?: PluginStateSource;
  /** Storage-backed plugins folder. Defaults to `<rootDir>/storage/plugins`. */
  readonly pluginsDir?: string;
}

/** The result of activation: loaded plugins plus every skipped id and issue. */
export interface ActivatePluginsResult {
  /** Loaded plugins, ordered deterministically by id. `setup` is never called. */
  readonly plugins: readonly JsailsPlugin[];
  /** The provenance-resolved autoload entries for the active plugins. */
  readonly autoload: readonly PluginAutoloadEntry[];
  /** Plugins excluded from activation, with the reason each was skipped. */
  readonly skipped: readonly SkippedPlugin[];
  /**
   * Discovery issues followed by activation issues (`invalid_entry`,
   * `plugin_load_failed`, `autoload_failed`).
   */
  readonly issues: readonly PluginIssue[];
}

/**
 * Discover, resolve, and import the enabled plugins. See the module doc for the
 * exact contract. Throws the discovery `PluginDiscoveryError` for a conflicting
 * id/version (never silently dropped); a per-plugin import or export failure is
 * reported as an issue, never thrown.
 */
export async function activatePlugins(input: ActivatePluginsInput): Promise<ActivatePluginsResult> {
  const { enablement, state } = await loadPluginEnablementState({
    codeEnabled: input.codeEnabled,
    managed: input.managed,
    stateSource: input.stateSource,
  });

  const activeVersions: Record<string, string> = {};
  for (const [id, entry] of Object.entries(state?.plugins ?? {})) {
    activeVersions[id] = entry.active;
  }

  const discovery = discoverPlugins({
    rootDir: input.rootDir,
    pluginsDir: input.pluginsDir,
    enabled: enablement.enabled,
    activeVersions,
  });

  const issues: PluginIssue[] = [...discovery.issues];
  const plugins: JsailsPlugin[] = [];
  const loaded: DiscoveredPlugin[] = [];

  for (const plugin of discovery.plugins) {
    const specifier = entrySpecifier(plugin);
    const target = resolveEntryTarget(plugin, specifier);
    if (target === undefined) {
      issues.push(invalidEntry(plugin, specifier));
      continue;
    }
    let namespace: unknown;
    try {
      namespace = await import(target);
    } catch (error) {
      issues.push(loadFailure(plugin, specifier, errorDetail(error)));
      continue;
    }
    const extracted = extractPlugins(namespace);
    if (extracted === undefined) {
      issues.push(loadFailure(plugin, specifier, 'invalid_export'));
      continue;
    }
    loaded.push(plugin);
    plugins.push(
      ...extracted.map((extension) =>
        gatePluginCapabilities(extension, plugin.id, plugin.manifest.permissions),
      ),
    );
  }

  // Provenance-scoped autoload: resolve which discovered plugins are active
  // (direct install wins; transitive installs are delegated or suppressed) and
  // project each active plugin's own surface onto `globalThis`. The direct set
  // is both npm-rooted plugins AND manager-enabled bundles: a bundle the manager
  // deliberately installed is a direct install, not a transitive one. Only
  // plugins whose entry loaded take part, and each plugin's projection is
  // guarded on its own so one bad specifier never aborts the others.
  const autoload = resolveMarketplaceAutoload(discovery.plugins, enablement.enabled).filter(
    (entry) => {
      const plugin = loaded.find((candidate) => candidate.id === entry.origin);
      if (plugin === undefined) return false;
      if (autoloadSpecifiersAllowed(plugin)) return true;
      issues.push(autoloadFailure(plugin, 'invalid_specifier'));
      return false;
    },
  );
  const installed: PluginAutoloadEntry[] = [];
  for (const entry of autoload) {
    try {
      await installPluginGlobals([entry]);
      installed.push(entry);
    } catch (error) {
      const plugin = loaded.find((candidate) => candidate.id === entry.origin);
      if (plugin !== undefined) issues.push(autoloadFailure(plugin, errorDetail(error)));
    }
  }

  return {
    plugins: sortPlugins(plugins),
    autoload: installed,
    skipped: discovery.skipped ?? [],
    issues,
  };
}

/**
 * Resolve the autoload exposure over a discovery result: build the install
 * graph (transposing `requiredBy` to forward `installs` edges), run
 * {@link resolveAutoloadExposure} with the directly-enabled ids as the direct
 * set, and return the active plugins' own-surface entries. Pure and deterministic.
 *
 * The direct set is `enabled` — the effective enablement union (npm code-enabled
 * plus manager-enabled) — not merely `root`, because a manager-installed bundle
 * is a direct install even though it is not an npm `dependencies` entry and
 * carries no `requiredBy`/provenance (bundles are opaque to the npm graph).
 *
 * Install edges come from two sources: npm `requiredBy` and declared
 * `manifest.plugins` bundle-to-bundle dependencies. A plugin that declares a
 * dependency (either way) *installs* it, so it is transitive unless directly
 * enabled, and exposed only if delegated by the installer's `autoload`.
 */
export function resolveMarketplaceAutoload(
  discovered: readonly DiscoveredPlugin[],
  directlyEnabled: readonly string[] = [],
): readonly PluginAutoloadEntry[] {
  // Forward `installs` edges, from two sources:
  //   (1) npm dependency edges, transposed from `requiredBy` (A installs B iff
  //       B.requiredBy includes A);
  //   (2) declared bundle-to-bundle edges: a plugin whose manifest `plugins`
  //       names another plugin id *installs* it (marketplace bundle-to-bundle
  //       requirements — distinct from npm package-level `dependencies`).
  const installsOf = new Map<string, string[]>();
  for (const plugin of discovered) {
    installsOf.set(plugin.id, []);
  }
  for (const plugin of discovered) {
    for (const installer of plugin.requiredBy ?? []) {
      const installs = installsOf.get(installer);
      if (installs !== undefined) {
        installs.push(plugin.id);
      }
    }
    for (const dependency of plugin.manifest.plugins ?? []) {
      const installs = installsOf.get(plugin.id);
      if (installs !== undefined && !installs.includes(dependency.id)) {
        installs.push(dependency.id);
      }
    }
  }

  const plugins = new Map<string, InstalledPlugin>();
  for (const plugin of discovered) {
    plugins.set(plugin.id, {
      id: plugin.id,
      autoload: plugin.manifest.autoload,
      installs: [...new Set(installsOf.get(plugin.id) ?? [])].sort(),
    });
  }

  // Direct installs: npm `root` dependencies plus every explicitly-enabled id
  // (which covers manager-enabled bundles that are not `root`).
  const directSet = new Set<string>();
  for (const plugin of discovered) {
    if (plugin.root === true) {
      directSet.add(plugin.id);
    }
  }
  for (const id of directlyEnabled) {
    if (plugins.has(id)) {
      directSet.add(id);
    }
  }
  const active = resolveAutoloadExposure({ direct: [...directSet], plugins });

  return discovered
    .filter((plugin) => active.has(plugin.id))
    .map((plugin) => ({ origin: plugin.id, autoload: plugin.manifest.autoload }));
}

/** A specifier with a URL scheme (`node:`, `data:`, `file:`, `https:`); a drive letter is not one. */
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/**
 * Resolve what `import()` should load for a plugin's entry: a `file:` URL for a
 * path, or a bare specifier when the package's own `exports` cannot be resolved
 * through `require` conditions. `undefined` when the entry is not allowed (see
 * the module doc).
 */
function resolveEntryTarget(plugin: DiscoveredPlugin, specifier: string): string | undefined {
  if (specifier === '' || URL_SCHEME_PATTERN.test(specifier)) return undefined;
  if (plugin.source === 'bundle') {
    const bundleDir = plugin.bundleDir ?? dirname(plugin.manifestPath);
    const relativePath = specifier.startsWith('./') ? specifier.slice(2) : specifier;
    try {
      assertPortablePath(relativePath);
    } catch {
      return undefined;
    }
    return fileTarget(bundleDir, relativePath);
  }
  const packageDir = dependencyPackageDir(plugin);
  if (!isBareSpecifier(specifier)) {
    if (isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier)) return undefined;
    return fileTarget(packageDir, specifier);
  }
  if (!isOwnPackageSpecifier(plugin, specifier)) return undefined;
  try {
    // Resolve from the plugin's own location, not from this module's, so a
    // nested (non-hoisted) copy of the package is the one that loads.
    return pathToFileURL(createRequire(plugin.manifestPath).resolve(specifier)).href;
  } catch {
    // An ESM-only package whose `exports` offer only an `import` condition is
    // not resolvable through `require`; Node's own ESM resolution handles it.
    return specifier;
  }
}

/** A `file:` URL for `path` under `baseDir`, or `undefined` when it escapes `baseDir`. */
function fileTarget(baseDir: string, path: string): string | undefined {
  const resolved = resolve(baseDir, path);
  const offset = relative(baseDir, resolved);
  if (offset === '' || offset.startsWith('..') || isAbsolute(offset)) return undefined;
  return pathToFileURL(resolved).href;
}

/** Whether a bare specifier names the plugin's own package or one of its subpaths. */
function isOwnPackageSpecifier(plugin: DiscoveredPlugin, specifier: string): boolean {
  const name = plugin.packageName;
  if (name === undefined || name === '') return false;
  return specifier === name || specifier.startsWith(`${name}/`);
}

/**
 * Whether a plugin's autoload specifiers are its own: a dependency plugin may
 * name only its own package and subpaths. A bundle is not an npm package, so a
 * bare specifier in its manifest would resolve some other installed package;
 * bundles therefore cannot autoload specifiers.
 */
function autoloadSpecifiersAllowed(plugin: DiscoveredPlugin): boolean {
  const declaration = plugin.manifest.autoload;
  if (declaration === undefined || declaration.mode !== 'selected') return true;
  const specifiers = declaration.specifiers ?? [];
  if (specifiers.length === 0) return true;
  if (plugin.source === 'bundle') return false;
  return specifiers.every(
    (specifier) =>
      !URL_SCHEME_PATTERN.test(specifier) &&
      isBareSpecifier(specifier) &&
      isOwnPackageSpecifier(plugin, specifier),
  );
}

/**
 * Whether an entry specifier is a bare module specifier (not a relative or
 * absolute file path). A bare specifier (e.g. `jsails/auth`, `@acme/blog`,
 * `pkg`) is imported directly via `import(specifier)` — Node resolves it
 * through `node_modules` from the importing module's location. A relative
 * path (`./`, `../`), a POSIX absolute path (`/`), or a Windows drive-letter
 * path (`C:\`, `D:/`) returns false and is resolved as a file path against the
 * plugin's package directory.
 */
export function isBareSpecifier(entry: string): boolean {
  if (entry.startsWith('./') || entry.startsWith('../') || entry.startsWith('/')) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(entry)) {
    return false;
  }
  return true;
}

/**
 * The package directory of a dependency-source plugin. `manifestPath` is the
 * `package.json` discovery resolved (its walk never leaves `rootDir`), so its
 * directory is the exact package location — correct for a hoisted or nested
 * transitive dependency alike. This reuses discovery's recorded resolution (the
 * resolver itself is not exported); the equivalent manual form is
 * `<rootDir>/node_modules/<name>`, bounded to `rootDir`.
 */
function dependencyPackageDir(plugin: DiscoveredPlugin): string {
  return dirname(plugin.manifestPath);
}

/**
 * The entry module specifier for a plugin. Primary is the manifest `entry` (the
 * `jsails.entry` field); when it is somehow empty, fall back to the package's
 * `exports`/`main`. The manifest schema requires `entry`, so the fallback is
 * defensive only and reads the `package.json` through the manifest path.
 */
function entrySpecifier(plugin: DiscoveredPlugin): string {
  if (plugin.manifest.entry !== '') {
    return plugin.manifest.entry;
  }
  return fallbackEntry(plugin);
}

/** Recover an entry specifier from the package.json `exports`/`main` fields. */
function fallbackEntry(plugin: DiscoveredPlugin): string {
  let raw: string;
  try {
    raw = readFileSync(plugin.manifestPath, 'utf8');
  } catch {
    return '';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '';
  }
  const record = parsed as Record<string, unknown>;
  const fromExports = stringFromExports(record['exports']);
  if (fromExports !== undefined) {
    return fromExports;
  }
  const main = record['main'];
  return typeof main === 'string' ? main : '';
}

/** A string `exports` value, or the first string under a conventional subpath. */
function stringFromExports(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['.', 'import', 'default', 'require', 'node']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Extract plugin(s) from an imported module namespace. The default export wins
 * when present (as a plugin or an array of plugins, flattened); otherwise the
 * `plugins` named export is tried. Returns `undefined` when neither yields a
 * valid plugin list.
 */
function extractPlugins(namespace: unknown): JsailsPlugin[] | undefined {
  const record = namespace as Record<string, unknown>;
  const fromDefault = normalizeExport(record['default']);
  if (fromDefault !== undefined) {
    return fromDefault;
  }
  return normalizeExport(record['plugins']);
}

/** Normalize an export value into a validated plugin list, or `undefined`. */
function normalizeExport(value: unknown): JsailsPlugin[] | undefined {
  if (Array.isArray(value)) {
    const flattened = value.flat();
    return flattened.every(isJsailsPlugin) ? flattened : undefined;
  }
  return isJsailsPlugin(value) ? [value] : undefined;
}

/** A value-free activation failure issue; module contents are never echoed. */
function loadFailure(plugin: DiscoveredPlugin, entryPath: string, detail: string): PluginIssue {
  return {
    source: plugin.source,
    code: 'plugin_load_failed',
    message: `plugin "${plugin.id}" failed to load (${detail})`,
    path: entryPath,
    pluginId: plugin.id,
    detail,
  };
}

/** A value-free issue for an entry specifier activation refuses to import. */
function invalidEntry(plugin: DiscoveredPlugin, entryPath: string): PluginIssue {
  return {
    source: plugin.source,
    code: 'invalid_entry',
    message: `plugin "${plugin.id}" declares an entry that is not allowed`,
    path: entryPath,
    pluginId: plugin.id,
  };
}

/** A value-free issue for a plugin whose autoload globals could not be installed. */
function autoloadFailure(plugin: DiscoveredPlugin, detail: string): PluginIssue {
  return {
    source: plugin.source,
    code: 'autoload_failed',
    message: `plugin "${plugin.id}" autoload could not be installed (${detail})`,
    pluginId: plugin.id,
    detail,
  };
}

/** Built-in error names safe to report: they describe the failure class only. */
const BUILTIN_ERROR_NAMES = new Set([
  'Error',
  'SyntaxError',
  'TypeError',
  'ReferenceError',
  'RangeError',
  'URIError',
  'EvalError',
  'AggregateError',
]);

/**
 * A value-free description of a thrown error: its Node error code (such as
 * `ERR_MODULE_NOT_FOUND`) or its built-in error name. The message, which may
 * embed paths, module contents, or secrets, is never read.
 */
function errorDetail(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && BUILTIN_ERROR_NAMES.has(name)) return name;
  }
  return 'unknown_error';
}

/** Order plugins deterministically by id (the extension `name`). */
function sortPlugins(plugins: readonly JsailsPlugin[]): JsailsPlugin[] {
  return [...plugins].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
