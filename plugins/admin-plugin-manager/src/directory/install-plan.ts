/**
 * Directory install planning: pure, side-effect-free translation of a directory
 * entry plus installed-state into a single installer operation.
 *
 * The plugin installer's surface is `install({ id, version, url })`,
 * `uninstall(id)`, and `rollback(id, version)`; "update" is just an install at a
 * newer version. This module maps the curated directory onto that surface:
 *
 * - {@link planPluginInstall} plans a fresh install at the entry's
 *   `latestVersion` when the plugin is not already installed.
 * - {@link planPluginUpdate} plans an install at `latestVersion` when it is a
 *   semantic upgrade over the active version.
 * - {@link planPluginRollback} plans a rollback to a caller-supplied previous
 *   version (the installer's rollback only flips to an already-installed
 *   version, and there is no ledger, so the previous version must be supplied).
 *
 * Every planner is pure: no network, no filesystem, no subprocess. Each also
 * gates the plan on framework compatibility (`entry.frameworkRange` must be
 * satisfied by the supplied framework version, so an incompatible install is
 * refused at plan time). All failures raise a value-free
 * {@link InstallPlanError}; raw ids, versions, and specifiers are never echoed.
 */

import { isValidSemverVersion, satisfiesRange } from 'jsails/plugins';
import type { PluginState } from 'jsails/plugins';
import type { PluginDirectoryEntry } from './catalog.js';
import { compareVersions } from './versions.js';

// ---------------------------------------------------------------------------
// Plan shapes and their error
// ---------------------------------------------------------------------------

/** Stable machine code carried by every {@link InstallPlanError}. */
export type InstallPlanErrorCode =
  | 'invalid_entry'
  | 'invalid_framework'
  | 'incompatible_version'
  | 'already_installed'
  | 'unknown_plugin'
  | 'invalid_installed'
  | 'up_to_date'
  | 'not_upgrade'
  | 'no_previous_version'
  | 'same_version'
  | 'invalid_previous_version';

/** Raised for any install-planning failure; messages and codes are value-free. */
export class InstallPlanError extends Error {
  readonly code: InstallPlanErrorCode;

  constructor(code: InstallPlanErrorCode, message: string) {
    super(message);
    this.name = 'InstallPlanError';
    this.code = code;
  }
}

/** The currently installed version of a plugin, plus its rollback target. */
export interface InstalledPlugin {
  /** The active version (valid semver). */
  readonly version: string;
  /** The previously active version to roll back to; absent when unknown. */
  readonly previousVersion?: string;
}

/** A planned installer operation. */
export type InstallPlan =
  | {
      readonly action: 'install';
      readonly pluginId: string;
      readonly toVersion: string;
      readonly specifier: string;
    }
  | {
      readonly action: 'update';
      readonly pluginId: string;
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly specifier: string;
    }
  | {
      readonly action: 'rollback';
      readonly pluginId: string;
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly specifier: string;
    };

// ---------------------------------------------------------------------------
// Planners
// ---------------------------------------------------------------------------

/**
 * Plan a fresh install of `entry` at `entry.latestVersion`. Rejects a plugin
 * already recorded in `state` (`already_installed`) and an incompatible
 * framework version. `state` is the persisted plugin state document.
 */
export function planPluginInstall(
  entry: PluginDirectoryEntry,
  state: PluginState,
  frameworkVersion: string,
): InstallPlan {
  assertEntry(entry);
  assertCompatible(entry, frameworkVersion);
  if (Object.hasOwn(state.plugins, entry.id)) {
    throw new InstallPlanError('already_installed', 'plugin is already installed');
  }
  return Object.freeze({
    action: 'install',
    pluginId: entry.id,
    toVersion: entry.latestVersion,
    specifier: entry.specifier,
  });
}

/**
 * Plan an upgrade to `entry.latestVersion`. Rejects an unknown plugin
 * (`unknown_plugin` when `installed` is absent), a malformed active version,
 * a target that is not newer than the active version (`up_to_date` /
 * `not_upgrade`), and an incompatible framework version.
 */
export function planPluginUpdate(
  entry: PluginDirectoryEntry,
  installed: InstalledPlugin | undefined,
  frameworkVersion: string,
): InstallPlan {
  assertEntry(entry);
  assertCompatible(entry, frameworkVersion);
  const current = assertInstalled(installed);
  const comparison = compareVersions(entry.latestVersion, current.version);
  if (comparison === 0) {
    throw new InstallPlanError('up_to_date', 'plugin is already at the latest version');
  }
  if (comparison < 0) {
    throw new InstallPlanError(
      'not_upgrade',
      'the latest version is not an upgrade over the installed version',
    );
  }
  return Object.freeze({
    action: 'update',
    pluginId: entry.id,
    fromVersion: current.version,
    toVersion: entry.latestVersion,
    specifier: entry.specifier,
  });
}

/**
 * Plan a rollback to the supplied previous version. Rejects an unknown plugin,
 * a rollback without a previous version (`no_previous_version`), a malformed
 * previous version, a previous version equal to the active version
 * (`same_version`), and an incompatible framework version.
 */
export function planPluginRollback(
  entry: PluginDirectoryEntry,
  installed: InstalledPlugin | undefined,
  frameworkVersion: string,
): InstallPlan {
  assertEntry(entry);
  assertCompatible(entry, frameworkVersion);
  const current = assertInstalled(installed);
  if (current.previousVersion === undefined) {
    throw new InstallPlanError('no_previous_version', 'no previous version to roll back to');
  }
  if (!isValidSemverVersion(current.previousVersion)) {
    throw new InstallPlanError('invalid_previous_version', 'previous version is not valid semver');
  }
  if (current.previousVersion === current.version) {
    throw new InstallPlanError('same_version', 'previous version equals the active version');
  }
  return Object.freeze({
    action: 'rollback',
    pluginId: entry.id,
    fromVersion: current.version,
    toVersion: current.previousVersion,
    specifier: entry.specifier,
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate the minimal essential entry fields (defensive; the directory already validates). */
function assertEntry(entry: PluginDirectoryEntry): void {
  if (entry === null || typeof entry !== 'object') {
    throw new InstallPlanError('invalid_entry', 'directory entry is invalid');
  }
  if (typeof entry.id !== 'string' || entry.id === '' || typeof entry.specifier !== 'string') {
    throw new InstallPlanError('invalid_entry', 'directory entry is invalid');
  }
  if (!isValidSemverVersion(entry.latestVersion)) {
    throw new InstallPlanError('invalid_entry', 'directory entry has an invalid version');
  }
}

/** Framework compatibility gate: value-free version + range rejection. */
function assertCompatible(entry: PluginDirectoryEntry, frameworkVersion: string): void {
  if (!isValidSemverVersion(frameworkVersion)) {
    throw new InstallPlanError('invalid_framework', 'framework version is not valid semver');
  }
  if (!satisfiesRange(frameworkVersion, entry.frameworkRange)) {
    throw new InstallPlanError(
      'incompatible_version',
      'plugin is not compatible with this framework',
    );
  }
}

/** Require an installed record with a valid active version; reject the unknown case. */
function assertInstalled(installed: InstalledPlugin | undefined): InstalledPlugin {
  if (installed === undefined || installed === null || typeof installed !== 'object') {
    throw new InstallPlanError('unknown_plugin', 'plugin is not installed');
  }
  if (!isValidSemverVersion(installed.version)) {
    throw new InstallPlanError('invalid_installed', 'installed version is not valid semver');
  }
  return installed;
}
