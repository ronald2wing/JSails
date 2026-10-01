/**
 * Manifest and bundle validation.
 *
 * Turns raw JSON into validated {@link PluginManifestV1}s and discovers
 * bundles from the storage-backed plugins folder. It never walks the dependency
 * graph — that is {@link ./scan.js} and {@link ./dependencies.js} — and it never
 * imports a module or opens a connection. Manifest shape validation is delegated
 * to {@link parsePluginManifest}; this module only records value-free issues and
 * decides whether a plugin is omitted or admitted.
 */

import { dirname, join } from 'node:path';

import { STAGING_PREFIX } from '../installed-bundles.js';
import {
  isValidSemverVersion,
  parsePluginManifest,
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FILENAME,
  PluginManifestError,
  type PluginManifestV1,
  type PluginManifestIssue,
} from '../manifest/index.js';

import type { DiscoveredPlugin, PluginDirent, PluginFs, PluginIssue } from './scan.js';

/**
 * Parse a raw `jsails` manifest value, recording a value-free `invalid_manifest`
 * issue on failure. Returns `undefined` when the manifest is invalid (the
 * plugin is omitted). `source` distinguishes a dependency manifest from a
 * storage bundle manifest; the issue shape is otherwise identical.
 */
function parseManifestOrIssue(
  raw: unknown,
  manifestPath: string,
  issues: PluginIssue[],
  source: 'dependency' | 'bundle',
): PluginManifestV1 | undefined {
  try {
    return parsePluginManifest(raw, source === 'dependency' ? 'package' : 'bundle');
  } catch (error) {
    const message =
      error instanceof PluginManifestError ? formatManifestIssues(error) : 'invalid manifest';
    issues.push({
      source,
      code: 'invalid_manifest',
      message,
      path: manifestPath,
      pluginId: readManifestId(raw),
    });
    return undefined;
  }
}

/**
 * Parse a raw `jsails` manifest value into a {@link PluginManifestV1}, recording a
 * value-free `invalid_manifest` issue on failure. Returns `undefined` when the
 * manifest is invalid (the plugin is omitted).
 */
export function parseDependencyManifest(
  raw: unknown,
  manifestPath: string,
  issues: PluginIssue[],
): PluginManifestV1 | undefined {
  return parseManifestOrIssue(raw, manifestPath, issues, 'dependency');
}

/**
 * Discover plugins from the storage-backed plugins folder, which has exactly
 * the layout the installer writes: `<pluginsDir>/<id>/<version>/manifest.json`.
 * Nothing deeper is read, so a `manifest.json` nested inside a bundle is never
 * a plugin, and a manifest must name the id and version its directories do
 * (`bundle_mismatch` otherwise): a bundle cannot claim another plugin's
 * identity by where it was placed. A directory whose name is not a plugin id
 * or a version (the installer's private staging directories among them) and
 * every symlink are skipped.
 */
export function discoverBundles(
  fs: PluginFs,
  pluginsDir: string,
  plugins: DiscoveredPlugin[],
  issues: PluginIssue[],
): void {
  for (const id of listDirectories(fs, pluginsDir)) {
    if (id.startsWith(STAGING_PREFIX) || !PLUGIN_ID_PATTERN.test(id)) continue;
    for (const version of listDirectories(fs, join(pluginsDir, id))) {
      if (!isValidSemverVersion(version)) continue;
      readVersionDir(fs, join(pluginsDir, id, version), { id, version }, plugins, issues);
    }
  }
}

/** The names of the real (non-symlink) subdirectories of `dir`, sorted; none when unreadable. */
function listDirectories(fs: PluginFs, dir: string): string[] {
  let entries: readonly PluginDirent[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // A missing plugins folder is an empty bundle set, not an error.
    return [];
  }
  return entries
    .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Read the one manifest of an installed `<id>/<version>/` directory. */
function readVersionDir(
  fs: PluginFs,
  dir: string,
  expected: { readonly id: string; readonly version: string },
  plugins: DiscoveredPlugin[],
  issues: PluginIssue[],
): void {
  const manifestPath = join(dir, PLUGIN_MANIFEST_FILENAME);
  let entries: readonly PluginDirent[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  const hasManifest = entries.some(
    (entry) => !entry.isSymbolicLink() && entry.isFile() && entry.name === PLUGIN_MANIFEST_FILENAME,
  );
  if (!hasManifest) {
    issues.push({
      source: 'bundle',
      code: 'manifest_missing',
      message: 'installed bundle has no manifest at its root',
      path: manifestPath,
      pluginId: expected.id,
    });
    return;
  }
  const discovered: DiscoveredPlugin[] = [];
  readBundleManifest(fs, manifestPath, discovered, issues);
  for (const plugin of discovered) {
    if (plugin.id !== expected.id || plugin.version !== expected.version) {
      issues.push({
        source: 'bundle',
        code: 'bundle_mismatch',
        message: 'bundle manifest does not name the id and version of its directory',
        path: manifestPath,
        pluginId: expected.id,
      });
      continue;
    }
    plugins.push(plugin);
  }
}

function readBundleManifest(
  fs: PluginFs,
  manifestPath: string,
  plugins: DiscoveredPlugin[],
  issues: PluginIssue[],
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath);
  } catch {
    issues.push({
      source: 'bundle',
      code: 'manifest_unreadable',
      message: 'bundle manifest could not be read',
      path: manifestPath,
    });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push({
      source: 'bundle',
      code: 'invalid_manifest',
      message: 'bundle manifest is not valid JSON',
      path: manifestPath,
    });
    return;
  }
  addBundlePlugin(plugins, issues, parsed, manifestPath);
}

/**
 * Keep only the bundle version activation may load for each id. An id with a
 * recorded active version admits exactly that version (`active_version_missing`
 * when it is not on disk); an id without one admits its single installed
 * version, and is `ambiguous_bundle_version` (none admitted) when more than
 * one is installed. Older versions stay on disk for rollback, but loading two
 * versions of one plugin would run both, and a rollback must actually stop the
 * version it rolled away from.
 *
 * Non-active versions are dropped for every id, but the two issues are only
 * recorded for an id `reportable` accepts (by default every id), so a plugin
 * that will not load anyway does not surface as a load failure.
 */
export function selectActiveBundles(
  bundles: readonly DiscoveredPlugin[],
  activeVersions: Readonly<Record<string, string>>,
  issues: PluginIssue[],
  reportable: (id: string) => boolean = () => true,
): DiscoveredPlugin[] {
  const byId = new Map<string, DiscoveredPlugin[]>();
  for (const bundle of bundles) {
    const list = byId.get(bundle.id);
    if (list === undefined) byId.set(bundle.id, [bundle]);
    else list.push(bundle);
  }
  const selected: DiscoveredPlugin[] = [];
  for (const [id, versions] of byId) {
    const active = Object.hasOwn(activeVersions, id) ? activeVersions[id] : undefined;
    if (active !== undefined) {
      const match = versions.filter((bundle) => bundle.version === active);
      if (match.length === 0 && reportable(id)) {
        issues.push({
          source: 'bundle',
          code: 'active_version_missing',
          message: `plugin "${id}" active version is not installed`,
          pluginId: id,
        });
      }
      selected.push(...match);
      continue;
    }
    if (versions.length > 1) {
      if (reportable(id)) {
        issues.push({
          source: 'bundle',
          code: 'ambiguous_bundle_version',
          message: `plugin "${id}" has several installed versions and no recorded active version`,
          pluginId: id,
        });
      }
      continue;
    }
    selected.push(...versions);
  }
  return selected;
}

/**
 * Parse a raw bundle manifest into a discovered plugin, recording an issue (with
 * value-free details) on failure. Bundles stay opaque to the dependency graph:
 * they are never `root`, never required by a plugin, and carry no provenance.
 */
function addBundlePlugin(
  plugins: DiscoveredPlugin[],
  issues: PluginIssue[],
  raw: unknown,
  manifestPath: string,
): void {
  const manifest = parseManifestOrIssue(raw, manifestPath, issues, 'bundle');
  if (manifest === undefined) {
    return;
  }
  plugins.push({
    id: manifest.id,
    version: manifest.version,
    source: 'bundle',
    manifest,
    manifestPath,
    bundleDir: dirname(manifestPath),
    root: false,
    requiredBy: [],
    provenanceChain: [],
  });
}

/** Extract a best-effort plugin id from a raw manifest for issue attribution. */
function readManifestId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const id = (raw as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Render a value-free summary of the manifest issues (never raw values). */
function formatManifestIssues(error: PluginManifestError): string {
  return `invalid plugin manifest: ${error.issues.map(renderIssue).join('; ')}`;
}

function renderIssue(issue: PluginManifestIssue): string {
  const location = issue.path.length > 0 ? issue.path.join('.') : '(manifest)';
  return `${location}: ${issue.message}`;
}
