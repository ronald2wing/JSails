/**
 * Environment-driven disk factory: build exactly the {@link Disk} a deployment
 * selected, from conventional `FILESYSTEM_*` and `S3_*` variables.
 *
 * `FILESYSTEM_DISK=local|s3` (or `memory`) selects the backend; only the chosen
 * disk is constructed, so a misconfigured S3 environment never builds a local
 * disk (and vice versa). Malformed or missing configuration throws `TypeError`
 * listing the specific problem, never a partial disk.
 */

import { type Disk } from 'jsails/filesystem';
import { LocalDisk, type LocalDiskOptions } from './local-disk.js';
import { MemoryDisk } from './memory-disk.js';
import { S3Disk, type S3DiskOptions } from './s3-disk.js';

/** The backend selectors {@link createDiskFromEnv} accepts. */
export type DiskKind = 'local' | 's3' | 'memory';

/** A selected disk paired with the name it was built under. */
export interface NamedDisk {
  readonly name: string;
  readonly disk: Disk;
}

/** Trimmed value of `name` in `env`, or `undefined` when absent/blank. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Parse `FILESYSTEM_DISK`, rejecting empty strings and unknown values. */
function selectKind(env: NodeJS.ProcessEnv): DiskKind {
  const raw = env.FILESYSTEM_DISK;
  // An unset selector is the safe local default; a present-but-blank value is
  // a configuration mistake and is rejected below.
  if (raw === undefined) return 'local';
  const kind = raw.trim().toLowerCase();
  if (kind === '') {
    throw new TypeError('FILESYSTEM_DISK must be "local", "s3", or "memory"');
  }
  if (kind === 'local' || kind === 's3' || kind === 'memory') {
    return kind;
  }
  throw new TypeError('FILESYSTEM_DISK must be "local", "s3", or "memory"');
}

/** Parse a boolean env flag (`S3_FORCE_PATH_STYLE`): false unless an explicit truthy value. */
function parseFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/** Build the options for the selected S3 backend, validating required fields. */
function s3Options(env: NodeJS.ProcessEnv): S3DiskOptions {
  const bucket = read(env, 'S3_BUCKET');
  if (bucket === undefined) {
    throw new TypeError('S3_BUCKET must be set when FILESYSTEM_DISK=s3');
  }
  const region = read(env, 'S3_REGION');
  if (region === undefined) {
    throw new TypeError('S3_REGION must be set when FILESYSTEM_DISK=s3');
  }
  const accessKeyId = read(env, 'S3_ACCESS_KEY_ID');
  const secretAccessKey = read(env, 'S3_SECRET_ACCESS_KEY');
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new TypeError('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together');
  }
  const options: S3DiskOptions = {
    bucket,
    region,
    endpoint: read(env, 'S3_ENDPOINT'),
    forcePathStyle: parseFlag(read(env, 'S3_FORCE_PATH_STYLE')),
    prefix: read(env, 'S3_PREFIX'),
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
 * Construct the single disk named by `FILESYSTEM_DISK` (defaulting `env` to
 * `process.env`). Throws `TypeError` for a missing/unknown selector or for
 * invalid backend configuration; never returns a partially constructed disk.
 */
export function createDiskFromEnv(env: NodeJS.ProcessEnv = process.env): NamedDisk {
  if (env === null || typeof env !== 'object') {
    throw new TypeError('env must be a process-style environment object');
  }
  const kind = selectKind(env);
  switch (kind) {
    case 'local': {
      const root = read(env, 'FILESYSTEM_LOCAL_ROOT') ?? 'storage/files';
      return { name: 'local', disk: new LocalDisk({ root } satisfies LocalDiskOptions) };
    }
    case 's3':
      return { name: 's3', disk: new S3Disk(s3Options(env)) };
    case 'memory':
      return { name: 'memory', disk: new MemoryDisk() };
  }
}
