/**
 * The index of bundles already installed under `pluginsDir`, read from the
 * `<id>/<version>/` layout and the manifests inside it. Used by the installer's
 * dependency guards; a malformed installed bundle is skipped here and reported
 * by `jsails plugins check` instead.
 */

import { join } from 'node:path';

import type { PluginInstallerFs, PluginInstallerStat } from './installer.js';
import {
  PLUGIN_MANIFEST_FILENAME,
  isValidSemverVersion,
  parsePluginManifest,
  type PluginManifest,
} from './manifest/index.js';

/** Prefix of a private staging directory under `pluginsDir` (a leading dot keeps it out of plugin ids). */
export const STAGING_PREFIX = '.staging-';

/** Where installed bundles live and the filesystem they are read through. */
export interface InstalledBundlesLocation {
  readonly fs: PluginInstallerFs;
  readonly pluginsDir: string;
}

/** The installed versions of a bundle plugin, from `<pluginsDir>/<id>/` directory names. */
export function listInstalledVersions(location: InstalledBundlesLocation, id: string): string[] {
  let names: string[];
  try {
    names = location.fs.readdirSync(join(location.pluginsDir, id));
  } catch {
    return []; // the dependency is not installed at all.
  }
  return names.filter((name) => isValidSemverVersion(name));
}

/**
 * The ids of installed bundles (other than `targetId`) whose manifest
 * declares `targetId` as a dependency. Deterministic (sorted).
 */
export function findDependents(location: InstalledBundlesLocation, targetId: string): string[] {
  const dependents = new Set<string>();
  walkManifests(location.fs, location.pluginsDir, (manifest) => {
    if (manifest.id === targetId) return;
    for (const dependency of manifest.plugins ?? []) {
      if (dependency.id === targetId) {
        dependents.add(manifest.id);
        return;
      }
    }
  });
  return [...dependents].sort();
}

/**
 * Depth-first walk of `dir` for bundle manifests, invoking `visit` on each
 * parsed manifest. Symlinks and staging directories are skipped; a missing
 * directory, an unreadable file, or an invalid manifest is skipped so a
 * malformed installed bundle never blocks an unrelated uninstall.
 */
function walkManifests(
  fs: PluginInstallerFs,
  dir: string,
  visit: (manifest: PluginManifest) => void,
): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(STAGING_PREFIX)) {
      continue;
    }
    const path = join(dir, name);
    let stat: PluginInstallerStat;
    try {
      stat = fs.lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      walkManifests(fs, path, visit);
      continue;
    }
    if (name === PLUGIN_MANIFEST_FILENAME) {
      visitManifestIfParsable(fs, path, visit);
    }
  }
}

/** Read and parse a manifest file, invoking `visit` only when it parses cleanly. */
function visitManifestIfParsable(
  fs: PluginInstallerFs,
  path: string,
  visit: (manifest: PluginManifest) => void,
): void {
  let text: string;
  try {
    text = fs.readFileSync(path);
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  try {
    visit(parsePluginManifest(parsed));
  } catch {
    // An invalid manifest is skipped; `jsails plugins check` owns reporting it.
  }
}
