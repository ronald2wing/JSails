/**
 * Manifest and bundle validation.
 *
 * Turns raw JSON into validated {@link PluginManifest}s and discovers
 * bundles from the storage-backed plugins folder. It never walks the dependency
 * graph — that is {@link ./scan.js} and {@link ./dependencies.js} — and it never
 * imports a module or opens a connection. Manifest shape validation is delegated
 * to {@link parsePluginManifest}; this module only records value-free issues and
 * decides whether a plugin is omitted or admitted.
 */

import { dirname, join } from 'node:path';

import { STAGING_PREFIX } from '../installed-bundles.js';
import {
  parsePluginManifest,
  PLUGIN_MANIFEST_FILENAME,
  PluginManifestError,
  type PluginManifest,
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
): PluginManifest | undefined {
  try {
    return parsePluginManifest(raw);
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
 * Parse a raw `jsails` manifest value into a {@link PluginManifest}, recording a
 * value-free `invalid_manifest` issue on failure. Returns `undefined` when the
 * manifest is invalid (the plugin is omitted).
 */
export function parseDependencyManifest(
  raw: unknown,
  manifestPath: string,
  issues: PluginIssue[],
): PluginManifest | undefined {
  return parseManifestOrIssue(raw, manifestPath, issues, 'dependency');
}

/**
 * Discover plugins from the storage-backed plugins folder. A directory holding a
 * `manifest.json` is a bundle root: the walk records it and does not descend
 * further, so a nested `manifest.json` (a vendored dependency, a fixture) is
 * never mistaken for another plugin. The installer's private staging
 * directories and symlinks are never entered.
 */
export function discoverBundles(
  fs: PluginFs,
  pluginsDir: string,
  plugins: DiscoveredPlugin[],
  issues: PluginIssue[],
): void {
  walkBundleDir(fs, pluginsDir, plugins, issues);
}

function walkBundleDir(
  fs: PluginFs,
  dir: string,
  plugins: DiscoveredPlugin[],
  issues: PluginIssue[],
): void {
  let entries: readonly PluginDirent[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // A missing plugins folder is an empty bundle set, not an error.
    return;
  }
  const manifestEntry = entries.find(
    (entry) => !entry.isSymbolicLink() && entry.isFile() && entry.name === PLUGIN_MANIFEST_FILENAME,
  );
  if (manifestEntry !== undefined) {
    readBundleManifest(fs, join(dir, manifestEntry.name), plugins, issues);
    return;
  }
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    if (entry.isSymbolicLink() || entry.name.startsWith(STAGING_PREFIX)) {
      continue;
    }
    if (entry.isDirectory()) {
      walkBundleDir(fs, join(dir, entry.name), plugins, issues);
    }
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
