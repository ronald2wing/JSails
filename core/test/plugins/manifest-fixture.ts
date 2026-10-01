/**
 * Manifest v1 fixtures for the plugin tests: the descriptive fields every
 * manifest needs, so a test states only the fields it is about.
 */

import type { PluginManifestV1 } from '../../src/plugins/manifest/index.js';

/** The fields v1 requires that a test about discovery or installs does not care about. */
export const MANIFEST_V1_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({
  manifestVersion: 1,
  name: 'Fixture plugin',
  summary: 'A plugin the tests build.',
  publisher: 'acme',
  apiTier: 'stable',
});

/** A raw npm-package manifest (`jsails` field) with `fields` on top. */
export function packageManifestJson(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...MANIFEST_V1_FIELDS, ...fields };
}

/** A raw bundle `manifest.json` with `fields` on top. */
export function bundleManifestJson(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...MANIFEST_V1_FIELDS, marketplace: true, ...fields };
}

/** A parsed manifest as discovery would hand it on, for tests that skip the parser. */
export function parsedManifest(
  fields: Pick<PluginManifestV1, 'id' | 'version' | 'jsailsCompat' | 'entry'> &
    Partial<PluginManifestV1>,
): PluginManifestV1 {
  return {
    manifestVersion: 1,
    name: 'Fixture plugin',
    summary: 'A plugin the tests build.',
    publisher: 'acme',
    apiTier: 'stable',
    browserSafe: false,
    permissions: [],
    plugins: [],
    marketplace: false,
    ...fields,
  };
}
