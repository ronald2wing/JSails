/**
 * Browser-safe semver helpers (`jsails/semver`).
 *
 * The plugin manifest system uses this bounded, dependency-free semver subset.
 * It is a separate public subpath so browser-safe packages (themes) can validate
 * versions without importing the server-only plugin system.
 */

export {
  isValidSemverRange,
  isValidSemverVersion,
  parseSemver,
  satisfiesRange,
  type SemverVersion,
} from '../plugins/manifest/semver.js';
