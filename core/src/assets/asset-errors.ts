/**
 * The asset index's failure codes, `asset.*`. Each is value-free: a count, or
 * the URL path of a file the developer put in an asset root, never a request's
 * own text or a filesystem location.
 */

import { isContextValue } from '../errors/context-schema.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

const ASSET_ERRORS = {
  invalid_options: {
    kind: 'internal',
    message: "createAssetIndex takes a roots array, and a mode of 'snapshot' or 'watch'",
  },
  invalid_root: {
    kind: 'internal',
    message: 'an asset root must be a directory, not a symbolic link or a file',
    suggestion: 'point the root (config `public`) at a real directory, or remove it',
  },
  invalid_prefix: {
    kind: 'internal',
    message: 'an asset root prefix must be "/" or a valid asset path',
  },
  duplicate_asset: {
    kind: 'internal',
    message: '{count} asset path(s) are served by two roots, first {path}',
    context: { count: 'count', path: 'relative-path' },
    suggestion: 'give each asset root its own prefix, or remove one of the files',
  },
  route_collision: {
    kind: 'internal',
    message: '{count} asset path(s) equal a route or a reserved path, first {path}',
    context: { count: 'count', path: 'relative-path' },
    suggestion: 'rename or remove the file, or move the route: one path has one answer',
  },
  stale_assets: {
    kind: 'internal',
    message: 'asset {path} changed on disk after the asset index was built',
    context: { path: 'relative-path' },
    suggestion: 'restart the server after a deploy replaces files in an asset root',
  },
  read_failed: {
    kind: 'internal',
    message: 'asset {path} could not be read',
    context: { path: 'relative-path' },
    suggestion:
      'check that the server can read the asset root and the disk it is on; the cause names the system error',
  },
} as const;

/**
 * The asset index's codes: options that are not an index's, a root that is
 * not a directory, a malformed root prefix, a path two roots serve, an asset
 * whose path a route or the framework owns (each failing assembly), an
 * indexed file that no longer matches the index when served, and a root or
 * file the filesystem failed to read for a reason other than its permissions
 * (`.` names the root itself).
 *
 * @public
 */
export const AssetErrors: ErrorRegistry<'asset', typeof ASSET_ERRORS> = defineErrors(
  'asset',
  ASSET_ERRORS,
);

/**
 * `path` as a `relative-path` slot: without its leading slash, `.` for the
 * root, and `unnamed` for a valid asset path the slot cannot carry (one that
 * reads like a drive letter, or longer than a slot allows).
 */
export function pathSlot(path: string): string {
  const relative = path.replace(/^\/+/, '');
  if (relative === '') return '.';
  return isContextValue('relative-path', relative) ? relative : 'unnamed';
}
