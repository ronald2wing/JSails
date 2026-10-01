/**
 * Plugin installer execution: download, verify, extract, and atomically install
 * a plugin bundle into a versioned directory, then record the active version in
 * the persisted plugin state.
 *
 * `createPluginInstaller` returns a small installer surface — `install`,
 * `uninstall`, `rollback` — that never evaluates plugin code. `install` downloads
 * a `.tgz` bundle through `guardedFetch` (bounded bytes and time, sanitized
 * errors, credentials never echoed, credential-free `https:` only, at most five
 * redirects, each hop checked against the input's optional `allowedHosts`),
 * refusing any URL or redirect whose host resolves to a private network
 * address, and connecting only to the address it checked, unless the installer
 * was built with `allowPrivateHosts` (which also admits plain `http:` to a
 * loopback address); it then verifies its integrity, requires exactly one manifest
 * (at the root once a single shared top-level directory is stripped),
 * validates it against the requested id/version, writes the flattened bundle
 * into a private staging directory under `pluginsDir`, then atomically renames
 * it into `<pluginsDir>/<id>/<version>/` and records `active = version` for
 * that one id in the state store, keeping an existing entry's settings and
 * enabled flag (a first install is enabled). An existing version directory is
 * never overwritten.
 *
 * Integrity is mandatory: the bundle must match a supplied SHA-256 checksum
 * (keyed by the URL basename; a map that does not cover the artifact is an
 * error) or a detached signature checked by the configured `verifySignature`.
 * A supplied signature with no verifier is an error. A bundle with neither is
 * refused (`unverified_bundle`) unless the caller passes `allowUnverified`,
 * which installs it and records a warning the caller must surface.
 *
 * Before committing, an install also refuses a bundle whose declared `plugins`
 * dependency is not already installed at a satisfying version (enforcement at
 * the install boundary, so a plugin with an unmet dependency fails fast rather
 * than resurfacing only through a later `jsails plugins check`).
 *
 * `uninstall` removes only `<pluginsDir>/<id>` (refusing a symlink target and a
 * plugin another installed bundle still depends on — the reverse half of the
 * install-time dependency check) and removes that id's state entry. Every
 * state write touches only the one id it is about, so an install never undoes
 * another process's change to a different plugin. Both dependency
 * guards can be bypassed explicitly with a `force` flag (`install({ force })`,
 * `uninstall(id, { force })`), for the deliberate out-of-order install or
 * group removal the caller owns. `rollback` flips the active version to an
 * already installed one without deleting files. Every operation is serialized
 * per `pluginsDir` through an in-process promise mutex, and every failure
 * raises a value-free {@link PluginInstallerError}. The installer never
 * evaluates download capability — callers gate installs behind
 * {@link resolveDownloadsCapability}.
 */

import { Encoding } from '../support/encoding.js';
import { guardedFetch, type GuardedFetch } from '../support/guarded-fetch.server.js';
import {
  existsSync as fsExistsSync,
  lstatSync as fsLstatSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  renameSync as fsRenameSync,
  rmSync as fsRmSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export { PluginInstallerError, type PluginInstallerErrorCode } from './installer-error.js';
import { PluginInstallerError } from './installer-error.js';
import { STAGING_PREFIX, findDependents, listInstalledVersions } from './installed-bundles.js';
import {
  assertDownloadUrl,
  assertDownloadUrlPolicy,
  assertIntegrity,
  assertManifestMatches,
  downloadBundle,
  extractBundle,
  flattenBundleEntries,
  parseExtractedManifest,
  verifyChecksum,
  verifySignature,
  type DownloadUrlPolicy,
  type VerifySignature,
} from './bundle-intake.js';
export type { DownloadUrlPolicy, VerifySignature } from './bundle-intake.js';
import {
  isValidSemverVersion,
  PLUGIN_ID_PATTERN,
  satisfiesRange,
  type PluginManifestV1,
} from './manifest/index.js';
import { createInstallerState } from './installer-state.js';
import { PluginStateStore, type PluginStateSource } from './state-store.js';

/** Default bound on a downloaded `.tgz` bundle, in bytes. */
export const DEFAULT_MAX_BYTES: number = 64 * 1024 * 1024;

/** The minimal file stat the installer needs (symlink/directory checks). */
export interface PluginInstallerStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The synchronous filesystem surface the installer uses (injectable for tests). */
export interface PluginInstallerFs {
  /** Create a directory (and parents) if missing. */
  mkdirSync(path: string, options?: { recursive: boolean }): unknown;
  /** Write a file's bytes; throws an errno-style error on failure. */
  writeFileSync(path: string, data: Uint8Array): void;
  /** Rename a path over a non-existent destination (atomic within one filesystem). */
  renameSync(from: string, to: string): void;
  /** Remove a file or directory tree. */
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  /** List the names of a directory's entries. */
  readdirSync(path: string): string[];
  /** Read a file's contents as UTF-8; throws an errno-style error on failure. */
  readFileSync(path: string): string;
  /** Whether a path exists (following symlinks). */
  existsSync(path: string): boolean;
  /** Stat a path without following a symlink. */
  lstatSync(path: string): PluginInstallerStat;
}

const defaultFs: PluginInstallerFs = {
  mkdirSync: (path, options) => fsMkdirSync(path, options),
  writeFileSync: (path, data) => fsWriteFileSync(path, data),
  renameSync: (from, to) => fsRenameSync(from, to),
  rmSync: (path, options) => fsRmSync(path, options),
  readdirSync: (path) => fsReaddirSync(path),
  readFileSync: (path) => fsReadFileSync(path, 'utf8'),
  existsSync: (path) => fsExistsSync(path),
  lstatSync: (path) => fsLstatSync(path),
};

/** Options for {@link createPluginInstaller}. */
export interface PluginInstallerOptions {
  /** Directory holding installed plugins; the target of installs and state. */
  readonly pluginsDir: string;
  /**
   * The outbound primitive bundles are downloaded through; defaults to
   * `guardedFetch`. A replacement receives the installer's guard options
   * (`allowPrivate`, `allowHosts`, the limits) and must honour them.
   */
  readonly fetch?: GuardedFetch;
  /** Persisted plugin state; defaults to a JSON store over `pluginsDir`. */
  readonly stateStore?: PluginStateSource;
  /** Injectable fs facade; defaults to `node:fs`. */
  readonly fs?: PluginInstallerFs;
  /** Bound on a downloaded bundle's compressed size. Defaults to 64 MiB. */
  readonly maxBytes?: number;
  /** Detached-signature verifier; when absent, a supplied signature is refused. */
  readonly verifySignature?: VerifySignature;
  /**
   * Let downloads reach loopback and private network addresses. Defaults to
   * `false`. Only for an installer whose URLs come from the operator directly
   * (a terminal, a local development registry); an installer behind an admin
   * form must keep it off, or the form becomes a way into the server's network.
   */
  readonly allowPrivateHosts?: boolean;
}

/**
 * Inputs to {@link PluginInstaller.install}. The inherited `allowedHosts`
 * applies to `url` and to every redirect the download follows.
 */
export interface InstallPluginInput extends DownloadUrlPolicy {
  /** Plugin id; must match {@link PLUGIN_ID_PATTERN}. */
  readonly id: string;
  /** Plugin version; must be valid semver. */
  readonly version: string;
  /** URL of the `.tgz` bundle to download. */
  readonly url: string;
  /** Artifact-name -> SHA-256 checksum map (the manifest checksums entry). */
  readonly checksums?: Readonly<Record<string, string>>;
  /** Detached signature over the bundle; requires a configured verifier. */
  readonly signature?: string;
  /**
   * Install a bundle that carries neither a checksum nor a signature. Defaults
   * to `false` (refused with `unverified_bundle`); when set, the result carries
   * a warning the caller must log.
   */
  readonly allowUnverified?: boolean;
  /** Bypass the unsatisfied-dependency guard. Defaults to `false` (the guard runs). */
  readonly force?: boolean;
}

/** Options for {@link PluginInstaller.uninstall}. */
interface PluginUninstallOptions {
  /** Bypass the "still required by another plugin" guard. Defaults to `false`. */
  readonly force?: boolean;
}

/** The outcome of a successful install. */
export interface PluginInstallResult {
  /** The installed plugin id. */
  readonly id: string;
  /** The installed version. */
  readonly version: string;
  /** Value-free warnings recorded during the install (e.g. an unverified bundle). */
  readonly warnings: readonly string[];
}

/** The installer surface. */
export interface PluginInstaller {
  install(input: InstallPluginInput): Promise<PluginInstallResult>;
  uninstall(id: string, options?: PluginUninstallOptions): Promise<void>;
  rollback(id: string, version: string): Promise<void>;
}

/** In-process install serialization, one promise chain per pluginsDir. */
const installLocks = new Map<string, Promise<unknown>>();

/**
 * Run `task` serialized against every other task for the same `key`: each task
 * waits for the previous one to settle (success or failure) before starting.
 */
function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = installLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  installLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Build the installer surface. See the module doc for the exact contract. */
export function createPluginInstaller(options: PluginInstallerOptions): PluginInstaller {
  const pluginsDir = options.pluginsDir;
  const fs = options.fs ?? defaultFs;
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new PluginInstallerError('invalid_options', 'fetch must be a function');
  }
  const fetchImpl = options.fetch ?? guardedFetch;
  const state = createInstallerState(options.stateStore ?? new PluginStateStore({ pluginsDir }));
  const maxBytes = resolveMaxBytes(options.maxBytes);
  const verifier = options.verifySignature;
  const allowPrivateHosts = resolveAllowPrivateHosts(options.allowPrivateHosts);
  const location = { fs, pluginsDir };

  return {
    install(input) {
      return withLock(pluginsDir, () => install(input));
    },
    uninstall(id, options) {
      return withLock(pluginsDir, () => uninstall(id, options));
    },
    rollback(id, version) {
      return withLock(pluginsDir, () => rollback(id, version));
    },
  };

  async function install(input: InstallPluginInput): Promise<PluginInstallResult> {
    const id = assertId(input.id);
    const version = assertVersion(input.version);
    const url = assertDownloadUrl(input.url);
    const policy = assertDownloadUrlPolicy(input);
    const warnings: string[] = [];

    const bytes = await downloadBundle(url, {
      ...policy,
      fetch: fetchImpl,
      maxBytes,
      allowPrivateHosts,
    });

    const checksumVerified = verifyChecksum(bytes, input.checksums, url);
    const signatureVerified = await verifySignature(bytes, input.signature, verifier);
    assertIntegrity(checksumVerified || signatureVerified, input.allowUnverified, warnings);

    const entries = flattenBundleEntries(extractBundle(bytes));

    const manifest = parseExtractedManifest(entries);
    assertManifestMatches(manifest, id, version);
    if (input.force !== true) {
      assertDependenciesSatisfied(manifest);
    }

    const stagingDir = createStagingDir();
    try {
      writeEntries(entries, stagingDir);
      const destDir = join(pluginsDir, id, version);
      if (!fs.existsSync(destDir)) {
        // Never overwrite an existing version directory: an already-installed
        // version is a no-op (its files are left untouched, state is re-recorded).
        fs.mkdirSync(join(pluginsDir, id), { recursive: true });
        fs.renameSync(stagingDir, destDir);
      }
    } catch (error) {
      if (error instanceof PluginInstallerError) throw error;
      throw new PluginInstallerError('install_failed', 'plugin could not be installed');
    } finally {
      removeStagingIfPresent(stagingDir);
    }

    await state.recordInstall(id, version);
    return { id, version, warnings };
  }

  async function uninstall(id: string, options?: PluginUninstallOptions): Promise<void> {
    const pluginId = assertId(id);
    const pluginDir = join(pluginsDir, pluginId);

    // A missing directory means the plugin is not installed; removal is a no-op.
    let stat: PluginInstallerStat | null = null;
    try {
      stat = fs.lstatSync(pluginDir);
    } catch {
      stat = null;
    }
    if (stat !== null) {
      if (stat.isSymbolicLink()) {
        throw new PluginInstallerError(
          'unsafe_uninstall',
          'refusing to remove a symlinked plugin directory',
        );
      }
      if (options?.force !== true) {
        assertNotRequired(pluginId);
      }
      try {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      } catch (error) {
        if (error instanceof PluginInstallerError) throw error;
        throw new PluginInstallerError('install_failed', 'plugin could not be removed');
      }
    }

    await state.removeEntry(pluginId);
  }

  async function rollback(id: string, version: string): Promise<void> {
    const pluginId = assertId(id);
    const targetVersion = assertVersion(version);

    const current = await state.load();
    const entry = current.plugins[pluginId];
    if (entry === undefined) {
      throw new PluginInstallerError('unknown_plugin', 'plugin is not installed');
    }
    if (!fs.existsSync(join(pluginsDir, pluginId, targetVersion))) {
      throw new PluginInstallerError('unknown_version', 'plugin version is not installed');
    }

    // Only the active version changes: the enabled flag and the plugin's
    // persisted settings belong to the plugin, not to one installed version.
    await state.putEntry(pluginId, { ...entry, active: targetVersion });
  }

  /**
   * Refuse to install a bundle whose declared plugin dependency is not already
   * available as an installed bundle. The manifest has already been parsed, so
   * every `plugins` range is a valid semver range and ids are unique; this only
   * asks whether some installed version satisfies each range. A dependency
   * satisfied by an npm-installed plugin rather than a bundle is a graph-level
   * concern for `jsails plugins check` — the manifest `plugins` field expresses
   * marketplace bundle-to-bundle requirements, while npm `dependencies`
   * expresses package-level requirements.
   */
  function assertDependenciesSatisfied(manifest: PluginManifestV1): void {
    for (const dependency of manifest.plugins ?? []) {
      const versions = listInstalledVersions(location, dependency.id);
      if (!versions.some((version) => satisfiesRange(version, dependency.range))) {
        throw new PluginInstallerError(
          'unsatisfied_dependency',
          `plugin "${manifest.id}" requires plugin "${dependency.id}" ` +
            `(${dependency.range}), which is not installed`,
        );
      }
    }
  }

  /**
   * Refuse to uninstall a plugin that another installed bundle still depends
   * on. This is the reverse half of {@link assertDependenciesSatisfied}: install
   * refuses when a dependency is missing, uninstall refuses when removing a
   * plugin would orphan a dependency. Only semver-parsed manifests count; an
   * unreadable or invalid manifest is skipped here and reported by `jsails
   * plugins check` instead.
   */
  function assertNotRequired(id: string): void {
    const dependents = findDependents(location, id);
    if (dependents.length > 0) {
      throw new PluginInstallerError(
        'required_by',
        `plugin "${id}" cannot be uninstalled: it is required by ` +
          dependents.map((dependent) => `"${dependent}"`).join(', '),
      );
    }
  }

  function createStagingDir(): string {
    const dir = join(pluginsDir, `${STAGING_PREFIX}${Encoding.hex(Encoding.randomBytes(8))}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      throw new PluginInstallerError('install_failed', 'plugin could not be installed');
    }
    return dir;
  }

  function writeEntries(entries: Map<string, Uint8Array>, stagingDir: string): void {
    try {
      for (const [path, data] of entries) {
        const target = join(stagingDir, path);
        fs.mkdirSync(dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
      }
    } catch (error) {
      if (error instanceof PluginInstallerError) throw error;
      throw new PluginInstallerError('install_failed', 'plugin files could not be written');
    }
  }

  function removeStagingIfPresent(stagingDir: string): void {
    if (!fs.existsSync(stagingDir)) return;
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Best-effort staging cleanup; never mask the original failure.
    }
  }
}

/** Validate an id against {@link PLUGIN_ID_PATTERN}, throwing value-free on failure. */
function assertId(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || !PLUGIN_ID_PATTERN.test(id)) {
    throw new PluginInstallerError('invalid_id', 'plugin id is invalid');
  }
  return id;
}

/** Validate a version as semver, throwing value-free on failure. */
function assertVersion(version: string): string {
  if (typeof version !== 'string' || !isValidSemverVersion(version)) {
    throw new PluginInstallerError('invalid_version', 'plugin version is invalid');
  }
  return version;
}

/** Validate the private-network opt-in: only an explicit boolean is accepted. */
function resolveAllowPrivateHosts(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new PluginInstallerError('invalid_options', 'allowPrivateHosts must be a boolean');
  }
  return value === true;
}

/** Resolve and validate the download byte bound. */
function resolveMaxBytes(maxBytes: number | undefined): number {
  const resolved = maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new PluginInstallerError('invalid_options', 'maxBytes must be a positive integer');
  }
  return resolved;
}
