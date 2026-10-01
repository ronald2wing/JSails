/**
 * Dependency-free semantic-version comparison for the plugin directory.
 *
 * The plugin system's `parseSemver` (re-exported from the manifest seam) parses
 * a semantic version; this module adds the precedence ordering parsing alone
 * does not provide, so the directory can sort entries by `latestVersion` and
 * the install planner can refuse a non-upgrade. It introduces no dependency and
 * mirrors the precedence rules already used by the plugin version check.
 */

import { parseSemver, type SemverVersion } from 'jsails/plugins';

/**
 * Compare two semantic versions, returning a negative value, zero, or a
 * positive value per semver precedence. A non-semver side sorts after any valid
 * version (so an invalid string never crashes a sort); two non-semver strings
 * compare lexicographically.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null && right === null) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (left === null) return 1;
  if (right === null) return -1;
  return compareParsed(left, right);
}

/** Semver precedence over stable-order components (build metadata is dropped). */
function compareParsed(a: SemverVersion, b: SemverVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Semver prerelease precedence: a version without a prerelease is higher. */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const comparison = comparePrereleaseIdentifier(a[i]!, b[i]!);
    if (comparison !== 0) return comparison;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Compare one prerelease identifier: numeric lower than alphanumeric. */
function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const left = Number(a);
    const right = Number(b);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
