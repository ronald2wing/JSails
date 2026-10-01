/**
 * The `filesystem.*` error registry: a lookup the configuration cannot
 * satisfy, a malformed option of the environment factory, and a missing or
 * invalid `FILESYSTEM_*` or `S3_*` variable. The requested name and the
 * variable's value are never echoed.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const FILESYSTEM_ERRORS = {
  unknown_disk: {
    kind: 'internal',
    message: 'no disk is configured under the requested name',
    suggestion: "add the disk to the filesystem plugin's `disks` map",
  },
  missing_default: {
    kind: 'internal',
    message: 'disk() needs a name when no default disk is configured',
    suggestion: "set the filesystem plugin's `default`, or pass a disk name",
  },
  invalid_option: {
    kind: 'internal',
    message: 'filesystem option {option} is invalid',
    context: { option: 'identifier' },
  },
  invalid_environment: {
    kind: 'internal',
    message: 'environment variable {variable} is missing or invalid',
    context: { variable: 'identifier' },
  },
} as const;

/**
 * The package's codes, `filesystem.*`.
 *
 * @public
 */
export const FilesystemErrors: ErrorRegistry<'filesystem', typeof FILESYSTEM_ERRORS> = defineErrors(
  'filesystem',
  FILESYSTEM_ERRORS,
);
