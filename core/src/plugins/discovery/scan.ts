/**
 * Dependency-tree scanning and the discovery result model.
 *
 * This is the raw filesystem layer of plugin discovery: it reads the
 * app `package.json`, scans its direct `dependencies` for packages that
 * self-identify through a `jsails` field, and resolves packages Node-style from
 * a plugin's own directory (walking up toward `rootDir` but never beyond). It
 * also owns the public result types (`DiscoveredPlugin`, `PluginIssue`, ...) and
 * the injectable fs facade shared by the other discovery modules. Manifest shape validation
 * lives in {@link ./validate.js}; the transitive walk, cycle detection, and
 * conflict resolution live in {@link ./dependencies.js}; {@link discoverPlugins}
 * ties the three together. Nothing here imports a module or opens a connection.
 */

import { readFileSync as fsReadFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { PluginManifestV1 } from '../manifest/index.js';

import { isErrno } from '../../errors/inspect.js';
import { parseDependencyManifest } from './validate.js';
import { JsailsError } from '../../errors/jsails-error.js';

/** The field name under which an npm plugin package self-identifies. */
const JSAILS_FIELD = 'jsails';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** A discovered plugin package: its manifest plus where it came from. */
export interface DiscoveredPlugin {
  /** Plugin id (from the manifest). */
  readonly id: string;
  /** Plugin version (from the manifest). */
  readonly version: string;
  /** The validated manifest, carried through verbatim. */
  readonly manifest: PluginManifestV1;
  /** Absolute path of the package.json that was read. */
  readonly manifestPath: string;
  /** npm package name. */
  readonly packageName: string;
  /** True when the plugin is a direct `dependencies` entry of the app package. */
  readonly root: boolean;
  /** Sorted unique ids of every plugin that directly requires this one. */
  readonly requiredBy: readonly string[];
  /** Sorted unique ids on any root-to-here path, including this plugin's id. */
  readonly provenanceChain: readonly string[];
}

/** A directed dependency edge: the `from` plugin id requires the `to` plugin id. */
export interface PluginEdge {
  readonly from: string;
  readonly to: string;
}

/** A non-fatal discovery problem (a warning; never a hard error). */
export interface PluginIssue {
  /** Stable machine code, e.g. `dependency_missing`, `invalid_manifest`. */
  readonly code: string;
  /** Value-free description (manifest content is never echoed). */
  readonly message: string;
  /** Path of the offending file, when one was identified. */
  readonly path?: string;
  /** Plugin id, when the manifest was valid enough to expose one. */
  readonly pluginId?: string;
}

/** Hard-error codes for {@link PluginDiscoveryError}. */
export type PluginDiscoveryErrorCode = 'duplicate_dependency_id';

/** Raised when two packages declare one plugin id at one version. */
export class PluginDiscoveryError extends JsailsError {
  constructor(
    readonly code: PluginDiscoveryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Options for {@link discoverPlugins}. */
export interface DiscoverPluginsOptions {
  /** Project root; the app `package.json` and `node_modules` resolve under it. */
  readonly rootDir: string;
  /** App `package.json` path. Defaults to `<rootDir>/package.json`. */
  readonly packageJsonPath?: string;
  /** Injectable fs facade (tests); defaults to `node:fs`. */
  readonly fs?: PluginFs;
}

/** The result of a discovery: sorted plugins plus non-fatal issues. */
export interface DiscoverPluginsResult {
  /** Discovered plugins, sorted by id, then version. */
  readonly plugins: readonly DiscoveredPlugin[];
  /** Non-fatal problems encountered while walking the dependencies. */
  readonly issues: readonly PluginIssue[];
  /** Directed plugin-to-plugin dependency edges, sorted by (from, to). */
  readonly edges: readonly PluginEdge[];
}

// ---------------------------------------------------------------------------
// Injectable fs facade
// ---------------------------------------------------------------------------

/**
 * The synchronous fs surface discovery uses: it reads `package.json` files
 * and never lists a directory.
 */
export interface PluginFs {
  /** Read a file as UTF-8; throws an errno-style error with a `code` on failure. */
  readFileSync(path: string): string;
}

export const defaultFs: PluginFs = Object.freeze<PluginFs>({
  readFileSync: (path) => fsReadFileSync(path, 'utf8'),
});

// ---------------------------------------------------------------------------
// Internal records
// ---------------------------------------------------------------------------

/** A dependency-source plugin read from an installed package.json. */
export interface DependencyPlugin {
  readonly id: string;
  readonly version: string;
  readonly packageName: string;
  readonly manifestPath: string;
  /** Directory holding the plugin package (resolution base for its deps). */
  readonly dir: string;
  /** The plugin package's own `dependencies` map (for transitive traversal). */
  readonly dependencies: ReadonlyMap<string, string>;
  readonly manifest: PluginManifestV1;
  readonly root: boolean;
  readonly requiredBy: Set<string>;
  readonly provenance: Set<string>;
}

/** A package resolved Node-style: its parsed contents plus where it lives. */
interface ResolvedPackage {
  readonly manifestPath: string;
  readonly dir: string;
  readonly raw: unknown;
}

/** App package.json contents discovery needs: its dependencies. */
interface AppPackage {
  readonly dependencies: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// App package reading
// ---------------------------------------------------------------------------

/** Read the app package.json; a missing or unreadable file means no dependencies. */
export function readAppPackage(fs: PluginFs, packageJsonPath: string): AppPackage {
  let raw: string;
  try {
    raw = fs.readFileSync(packageJsonPath);
  } catch {
    // Unreadable for any reason (ENOENT included): there is nothing to discover.
    return { dependencies: new Map() };
  }
  return parseAppPackage(raw);
}

/** Parse and validate the app package.json's `dependencies`. */
function parseAppPackage(raw: string): AppPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { dependencies: new Map() };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { dependencies: new Map() };
  }
  return { dependencies: parseDependencies((parsed as Record<string, unknown>)['dependencies']) };
}

/** Normalize a `dependencies` value into a name -> spec map (value-free). */
function parseDependencies(value: unknown): ReadonlyMap<string, string> {
  if (value === undefined) {
    return new Map();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return new Map();
  }
  const map = new Map<string, string>();
  for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spec === 'string' && spec.length > 0) {
      map.set(name, spec);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Direct dependency scanning
// ---------------------------------------------------------------------------

/**
 * Discover plugins from direct npm dependencies. Each dependency's installed
 * `package.json` is read; a dependency without a `jsails` field is skipped
 * (it is not a plugin), a missing/unreadable/invalid one is reported as an
 * issue. Only the app's own `dependencies` map is scanned — never
 * `devDependencies` or `peerDependencies` (transitive dependencies are handled
 * separately by {@link discoverTransitiveDependencies}).
 */
export function discoverDirectDependencies(
  fs: PluginFs,
  rootDir: string,
  dependencies: ReadonlyMap<string, string>,
  issues: PluginIssue[],
): DependencyPlugin[] {
  const nodeModulesDir = join(rootDir, 'node_modules');
  const names = [...dependencies.keys()].sort();
  const plugins: DependencyPlugin[] = [];
  for (const name of names) {
    const manifestPath = join(nodeModulesDir, ...name.split('/'), 'package.json');
    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        issues.push({
          code: 'dependency_missing',
          message: `dependency "${name}" is not installed`,
          path: manifestPath,
        });
      } else {
        issues.push({
          code: 'dependency_unreadable',
          message: `dependency "${name}" could not be read`,
          path: manifestPath,
        });
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      issues.push({
        code: 'dependency_unreadable',
        message: `dependency "${name}" has an unreadable package.json`,
        path: manifestPath,
      });
      continue;
    }

    const jsails = readJsailsField(parsed);
    if (jsails === undefined) {
      continue;
    }
    const manifest = parseDependencyManifest(jsails, manifestPath, issues);
    if (manifest === undefined) {
      continue;
    }

    plugins.push({
      id: manifest.id,
      version: manifest.version,
      packageName: name,
      manifestPath,
      dir: dirname(manifestPath),
      dependencies: readDependencies(parsed),
      manifest,
      root: true,
      requiredBy: new Set(),
      provenance: new Set([manifest.id]),
    });
  }
  return plugins;
}

// ---------------------------------------------------------------------------
// Package resolution and field reading
// ---------------------------------------------------------------------------

/**
 * Resolve `name` Node-style starting from `startDir`: look in
 * `<dir>/node_modules/<name>` for each ancestor of `startDir`, stopping once
 * `rootDir` itself has been checked (never walking beyond it). Returns the
 * resolved package on the first readable `package.json`, or `undefined` when the
 * package is not installed anywhere within `rootDir`.
 */
export function resolveInstalledPackage(
  fs: PluginFs,
  startDir: string,
  rootDir: string,
  name: string,
): ResolvedPackage | undefined {
  const segments = name.split('/');
  let dir = startDir;
  for (;;) {
    const manifestPath = join(dir, 'node_modules', ...segments, 'package.json');
    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath);
    } catch {
      // Not present at this level (any read failure means "keep walking up").
      if (dir === rootDir) {
        return undefined;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        return undefined; // filesystem root; defensive (should not happen).
      }
      dir = parent;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null; // unreadable package.json: treated as a non-plugin.
    }
    return { manifestPath, dir: dirname(manifestPath), raw: parsed };
  }
}

/** Extract the `dependencies` map from a parsed plugin package.json. */
export function readDependencies(parsed: unknown): ReadonlyMap<string, string> {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Map();
  }
  return parseDependencies((parsed as Record<string, unknown>)['dependencies']);
}

/** Read the `jsails` field of a parsed package.json, or `undefined` when absent. */
export function readJsailsField(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return (parsed as Record<string, unknown>)[JSAILS_FIELD];
}
