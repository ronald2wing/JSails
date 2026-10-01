/**
 * Plugin manifest v1 — public surface.
 *
 * - `manifest/schema.ts` — the manifest model ({@link PluginManifestV1}), its
 *   value-free {@link PluginManifestError}, and `checkPluginManifest` /
 *   `parsePluginManifest` for either carrier.
 * - `manifest/plugin-id.ts` — `PLUGIN_ID_PATTERN`, the id rule.
 * - `manifest/package-field.ts` — `parsePackageManifest` (an npm package's
 *   `jsails` field) and `parseBundleManifest` (a bundle's `manifest.json`).
 * - `manifest/semver.ts` — the dependency-free semver subset (`parseSemver`,
 *   `isValidSemverVersion`, `isValidSemverRange`, `satisfiesRange`).
 */

export {
  checkPluginManifest,
  parsePluginManifest,
  PluginManifestError,
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_MANIFEST_VERSION,
  type PluginManifestV1,
  type PluginManifestSource,
  type PluginManifestCheck,
  type PluginManifestErrorCode,
  type PluginManifestIssue,
  type PluginApiTier,
  type PluginDependency,
  type PluginSchemaDeclaration,
  type PluginAdminNavItem,
  type PluginToolDeclaration,
  type PluginEnvKind,
  type PluginEnvDeclaration,
} from './schema.js';

export { PLUGIN_ID_PATTERN } from './plugin-id.js';

export { parsePackageManifest, parseBundleManifest } from './package-field.js';

export {
  parseSemver,
  isValidSemverVersion,
  isValidSemverRange,
  satisfiesRange,
  type SemverVersion,
} from './semver.js';
