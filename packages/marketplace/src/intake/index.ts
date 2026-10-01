/**
 * Bundle intake: `openBundle` reads a bundle archive, strips at most one shared
 * top-level directory, requires exactly one root `manifest.json`, parses it as
 * a bundle manifest and checks that the files it names exist, returning the
 * archive digest, the manifest digest and the files. Nothing is imported or run.
 */

export { DIGEST_PATTERN, sha256Hex } from './digest.js';
export { IntakeErrors } from './intake-errors.js';
export { openBundle, type OpenBundleOptions, type OpenedBundle } from './open-bundle.js';
