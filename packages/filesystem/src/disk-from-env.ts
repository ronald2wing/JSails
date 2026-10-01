/**
 * Environment-driven disk factory: build exactly the {@link Disk} a deployment
 * selected, from conventional `FILESYSTEM_*` and `S3_*` variables.
 *
 * `FILESYSTEM_DISK=local|s3` (or `memory`) selects the backend; only the chosen
 * disk is constructed, so a misconfigured S3 environment never builds a local
 * disk (and vice versa). Malformed or missing configuration throws
 * `filesystem.invalid_environment` naming the variable (never its value), and
 * no partial disk is returned.
 *
 * The environment is always passed in: the `filesystem` plugin hands over the
 * variables it declares (validated, never the whole process environment), and
 * application code passes the environment it resolved.
 */

import { isAbsolute, resolve } from 'node:path';

import { type Disk } from 'jsails/filesystem';
import { firstConfigured } from 'jsails/plugin-sdk';
import { FilesystemErrors } from './filesystem-errors.js';
import { LocalDisk, type LocalDiskOptions } from './local-disk.js';
import { MemoryDisk } from './memory-disk.js';
import { S3Disk, type S3DiskOptions } from './s3-disk.js';

/**
 * The backend selectors {@link createDiskFromEnv} accepts.
 *
 * @public
 */
export type DiskKind = 'local' | 's3' | 'memory';

/**
 * A selected disk paired with the name it was built under.
 *
 * @public
 */
export interface NamedDisk {
  readonly name: string;
  readonly disk: Disk;
}

/**
 * The variables {@link createDiskFromEnv} reads: the process environment, or
 * the validated subset a plugin declares.
 *
 * @public
 */
export type DiskEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Options for {@link createDiskFromEnv}.
 *
 * @public
 */
export interface DiskFromEnvOptions {
  /**
   * The absolute directory a relative `FILESYSTEM_LOCAL_ROOT` (and the default
   * `storage/files`) resolves against. Without it a relative root resolves
   * against the working directory when the disk is used.
   */
  readonly rootDir?: string;
}

/** Trimmed value of `name` in `env`, or `undefined` when absent/blank. */
function read(env: DiskEnvironment, name: string): string | undefined {
  return firstConfigured(env[name])?.trim();
}

/** Parse `FILESYSTEM_DISK`, rejecting empty strings and unknown values. */
function selectKind(env: DiskEnvironment): DiskKind {
  const raw = env.FILESYSTEM_DISK;
  // An unset selector is the safe local default; a present-but-blank value is
  // a configuration mistake and is rejected below.
  if (raw === undefined) return 'local';
  const kind = raw.trim().toLowerCase();
  if (kind === 'local' || kind === 's3' || kind === 'memory') {
    return kind;
  }
  throw missing('FILESYSTEM_DISK');
}

function missing(variable: string): Error {
  return new FilesystemErrors.Error('invalid_environment', { variable });
}

/** Parse a boolean env flag (`S3_FORCE_PATH_STYLE`): false unless an explicit truthy value. */
function parseFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Parse `S3_CONDITIONAL_WRITES`: on unless explicitly off (`0`, `false`, `no`,
 * `off`), for a store that ignores `If-None-Match`. Any other value is a
 * mistake, refused rather than read as either.
 */
function parseConditionalWrites(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw missing('S3_CONDITIONAL_WRITES');
}

/** Build the options for the selected S3 backend, validating required fields. */
function s3Options(env: DiskEnvironment): S3DiskOptions {
  const bucket = read(env, 'S3_BUCKET');
  if (bucket === undefined) {
    throw missing('S3_BUCKET');
  }
  const region = read(env, 'S3_REGION');
  if (region === undefined) {
    throw missing('S3_REGION');
  }
  const accessKeyId = read(env, 'S3_ACCESS_KEY_ID');
  const secretAccessKey = read(env, 'S3_SECRET_ACCESS_KEY');
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw missing(accessKeyId === undefined ? 'S3_ACCESS_KEY_ID' : 'S3_SECRET_ACCESS_KEY');
  }
  const options: S3DiskOptions = {
    bucket,
    region,
    endpoint: read(env, 'S3_ENDPOINT'),
    forcePathStyle: parseFlag(read(env, 'S3_FORCE_PATH_STYLE')),
    prefix: read(env, 'S3_PREFIX'),
    conditionalWrites: parseConditionalWrites(read(env, 'S3_CONDITIONAL_WRITES')),
    credentials:
      accessKeyId !== undefined && secretAccessKey !== undefined
        ? {
            accessKeyId,
            secretAccessKey,
            sessionToken: read(env, 'S3_SESSION_TOKEN'),
          }
        : undefined,
  };
  return options;
}

/**
 * Construct the single disk `env`'s `FILESYSTEM_DISK` names. Throws
 * `filesystem.invalid_environment` for an unknown selector or missing backend
 * configuration; never returns a partially constructed disk.
 *
 * @public
 */
export function createDiskFromEnv(
  env: DiskEnvironment,
  options: DiskFromEnvOptions = {},
): NamedDisk {
  if (env === null || typeof env !== 'object') {
    throw new FilesystemErrors.Error('invalid_option', { option: 'env' });
  }
  if (options === null || typeof options !== 'object') {
    throw new FilesystemErrors.Error('invalid_option', { option: 'options' });
  }
  if (
    options.rootDir !== undefined &&
    (typeof options.rootDir !== 'string' || !isAbsolute(options.rootDir))
  ) {
    throw new FilesystemErrors.Error('invalid_option', { option: 'rootDir' });
  }
  const kind = selectKind(env);
  switch (kind) {
    case 'local': {
      const configured = read(env, 'FILESYSTEM_LOCAL_ROOT') ?? 'storage/files';
      const root =
        options.rootDir === undefined ? configured : resolve(options.rootDir, configured);
      return { name: 'local', disk: new LocalDisk({ root } satisfies LocalDiskOptions) };
    }
    case 's3':
      return { name: 's3', disk: new S3Disk(s3Options(env)) };
    case 'memory':
      return { name: 'memory', disk: new MemoryDisk() };
  }
}
