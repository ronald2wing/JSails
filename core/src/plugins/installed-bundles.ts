/**
 * The index of bundles already installed under `pluginsDir`, read from the
 * `<id>/<version>/manifest.json` layout the installer writes. Used by the installer's
 * dependency guards; a malformed installed bundle is skipped here and reported
 * by `jsails plugins check` instead.
 */

import { join } from 'node:path';

import type { PluginInstallerFs, PluginInstallerStat } from './installer.js';
import {
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FILENAME,
  isValidSemverVersion,
  parseBundleManifest,
  type PluginManifestV1,
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
 * declares `targetId` as a dependency. Deterministic (sorted). Only the
 * installer's layout is read (`<id>/<version>/manifest.json`, the manifest
 * naming that id and version), like discovery, so a stray nested manifest
 * neither blocks nor permits an uninstall.
 */
export function findDependents(location: InstalledBundlesLocation, targetId: string): string[] {
  const dependents = new Set<string>();
  for (const id of listPluginIds(location)) {
    if (id === targetId) continue;
    for (const version of listInstalledVersions(location, id)) {
      const path = join(location.pluginsDir, id, version, PLUGIN_MANIFEST_FILENAME);
      visitManifestIfParsable(location.fs, path, (manifest) => {
        if (manifest.id !== id || manifest.version !== version) return;
        if ((manifest.plugins ?? []).some((dependency) => dependency.id === targetId)) {
          dependents.add(id);
        }
      });
    }
  }
  return [...dependents].sort();
}

/** The plugin-id directories directly under `pluginsDir` (symlinks and staging skipped). */
function listPluginIds(location: InstalledBundlesLocation): string[] {
  let names: string[];
  try {
    names = location.fs.readdirSync(location.pluginsDir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (name.startsWith(STAGING_PREFIX) || !PLUGIN_ID_PATTERN.test(name)) return false;
    let stat: PluginInstallerStat;
    try {
      stat = location.fs.lstatSync(join(location.pluginsDir, name));
    } catch {
      return false;
    }
    return stat.isDirectory() && !stat.isSymbolicLink();
  });
}

/** Read and parse a manifest file, invoking `visit` only when it parses cleanly. */
function visitManifestIfParsable(
  fs: PluginInstallerFs,
  path: string,
  visit: (manifest: PluginManifestV1) => void,
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
    visit(parseBundleManifest(parsed));
  } catch {
    // An invalid manifest is skipped; `jsails plugins check` owns reporting it.
  }
}
