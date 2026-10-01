/**
 * Integrity input for every install the plugin manager starts: the raw form's
 * submitted SHA-256 or a directory entry's pinned digest becomes the
 * installer's `checksums` map, keyed by the bundle URL's basename (the key the
 * installer derives). A bundle with no digest is refused unless the app set
 * `allowUnverified`, and every warning the installer returns (an unverified
 * install among them) is reported through the configured warning sink.
 */

import type { InstallPluginInput, PluginInstallResult } from 'jsails/plugins';

import type { ResolvedPluginManagerOptions } from './plugin-manager.js';

/** A hex SHA-256 digest, optionally `sha256-` prefixed (the forms the installer accepts). */
export const SHA256_PATTERN = /^(?:sha256-)?[0-9a-f]{64}$/i;

/** The integrity fields of an {@link InstallPluginInput}. */
type IntegrityInput = Pick<InstallPluginInput, 'checksums' | 'allowUnverified'>;

/**
 * Resolve the integrity fields for a bundle at `url`: a checksum map when a
 * digest is known, `allowUnverified` when the app opted out, else `undefined`
 * (the caller refuses the install).
 */
export function integrityFor(
  url: string,
  sha256: string | undefined,
  options: ResolvedPluginManagerOptions,
): IntegrityInput | undefined {
  if (sha256 !== undefined) {
    return { checksums: { [artifactName(url)]: sha256 } };
  }
  return options.allowUnverified === true ? { allowUnverified: true } : undefined;
}

/** Report the installer's value-free warnings through the configured sink. */
export function reportInstallWarnings(
  result: PluginInstallResult | undefined,
  options: ResolvedPluginManagerOptions,
): void {
  for (const warning of result?.warnings ?? []) {
    options.warn(warning);
  }
}

/** Derive the bundle artifact name from a URL's path basename (query/fragment stripped). */
function artifactName(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split(/[?#]/)[0] ?? '';
  }
  const segments = pathname.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}
