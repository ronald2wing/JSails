/**
 * Theme package discovery (manifests only; no code execution).
 *
 * `discoverThemePackages` is pure over a caller-supplied file listing: it
 * never touches the filesystem. The caller reads manifest files and passes
 * their contents as `{ path, manifest }` entries; this module validates each
 * entry's package-relative path, parses its manifest, rejects duplicate names,
 * optionally gates the version against a supported semver range, and returns
 * the packages sorted by name. Malformed manifests, path escapes, duplicate
 * names, and unsupported versions are hard errors (a thrown
 * {@link ThemePackageError}), never silently dropped — a theme that cannot be
 * described safely must not be half-activated.
 */

import { satisfiesRange } from 'jsails/semver';
import {
  isSafeRelativePath,
  parseThemePackageManifest,
  ThemePackageError,
  type ThemePackageManifest,
} from './manifest.js';

/** A single discovery input: a package-relative path plus a raw manifest value. */
export interface ThemePackageEntry {
  /** Package-relative path of the theme package directory. */
  readonly path: string;
  /** Raw manifest value (already decoded from JSON by the caller). */
  readonly manifest: unknown;
}

/** A validated, discovered theme package: its manifest plus its location. */
export interface ThemePackage extends ThemePackageManifest {
  /** Package-relative path of the theme package directory. */
  readonly path: string;
}

/** Options for {@link discoverThemePackages}. */
export interface DiscoverThemePackagesOptions {
  /**
   * Optional semver range the theme version must satisfy. A version outside
   * the range is rejected with {@link ThemePackageError} code
   * `unsupported_version`. Omit it to accept any valid semver.
   */
  readonly supportedRange?: string;
}

/**
 * Discover and validate theme packages from a caller-supplied listing.
 * Returns a frozen, name-sorted array of {@link ThemePackage}s. Throws
 * {@link ThemePackageError} for a non-array `entries`, a malformed entry, an
 * unsafe path, a malformed manifest, a duplicate name, or an unsupported
 * version.
 */
export function discoverThemePackages(
  entries: readonly ThemePackageEntry[],
  options: DiscoverThemePackagesOptions = {},
): readonly ThemePackage[] {
  if (!Array.isArray(entries)) {
    throw new ThemePackageError('invalid_input', 'entries must be an array');
  }

  const seen = new Map<string, string>();
  const packages: ThemePackage[] = [];

  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ThemePackageError(
        'invalid_input',
        'each entry must be an object with path and manifest',
      );
    }
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== 'string' || !isSafeRelativePath(path)) {
      throw new ThemePackageError(
        'invalid_path',
        'entry path must be a safe package-relative path',
      );
    }
    const parsed = parseThemePackageManifest((entry as { manifest?: unknown }).manifest);

    if (seen.has(parsed.name)) {
      throw new ThemePackageError(
        'duplicate_name',
        `duplicate theme package name "${parsed.name}"`,
      );
    }
    seen.set(parsed.name, path);

    if (
      options.supportedRange !== undefined &&
      !satisfiesRange(parsed.version, options.supportedRange)
    ) {
      throw new ThemePackageError(
        'unsupported_version',
        `theme package "${parsed.name}" version "${parsed.version}" does not satisfy the supported range`,
      );
    }

    packages.push(Object.freeze({ ...parsed, path }));
  }

  return Object.freeze(
    [...packages].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  );
}
