/**
 * The two manifest carriers, named: the `jsails` field of an npm package's
 * `package.json`, and a marketplace bundle's `manifest.json`. Each is
 * {@link parsePluginManifest} with its source fixed, so a caller states which
 * carrier it read and the npm-only rules follow from that.
 */

import { parsePluginManifest, type PluginManifestV1 } from './schema.js';

/**
 * Parse the `jsails` field of an npm package's `package.json`.
 *
 * @public
 */
export function parsePackageManifest(raw: unknown): PluginManifestV1 {
  return parsePluginManifest(raw, 'package');
}

/**
 * Parse a marketplace bundle's `manifest.json`.
 *
 * @public
 */
export function parseBundleManifest(raw: unknown): PluginManifestV1 {
  return parsePluginManifest(raw, 'bundle');
}
