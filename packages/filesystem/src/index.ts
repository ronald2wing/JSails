/**
 * Filesystem implementation surface (`@jsails/filesystem`): the local,
 * in-memory and S3 disks, the environment-selected disk, the `filesystem`
 * plugin, and lazily materialized variants. The conformance suite for custom
 * disks is `@jsails/filesystem/testing`.
 */

export {
  createDiskFromEnv,
  type DiskEnvironment,
  type DiskFromEnvOptions,
  type DiskKind,
  type NamedDisk,
} from './disk-from-env.js';
export { FilesystemErrors } from './filesystem-errors.js';
export { LocalDisk, type LocalDiskOptions } from './local-disk.js';
export { MemoryDisk, type MemoryDiskOptions } from './memory-disk.js';
export { filesystemPlugin, type DiskSpec, type FilesystemPluginOptions } from './plugin.js';
export { filesystemPlugin as default } from './plugin.js';
export { S3Disk, type S3Dispatcher, type S3DiskOptions } from './s3-disk.js';
export {
  defineVariant,
  DiskVariantResolver,
  VariantErrors,
  type VariantDef,
  type VariantResolver,
  type VariantResolverOptions,
  type VariantTransform,
} from './variants.js';
