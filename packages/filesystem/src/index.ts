/** Filesystem implementation surface (`@jsails/filesystem`). */

export { LocalDisk, type LocalDiskOptions } from './local-disk.js';
export { MemoryDisk, type MemoryDiskOptions } from './memory-disk.js';
export { S3Disk, type S3DiskOptions } from './s3-disk.js';
export { createDiskFromEnv, type DiskKind, type NamedDisk } from './disk-from-env.js';
export {
  FileSystemError,
  filesystemPlugin,
  type FileSystemErrorCode,
  type FilesystemPluginOptions,
} from './plugin.js';
export { filesystemPlugin as default } from './plugin.js';
export {
  defineVariant,
  DiskVariantResolver,
  VariantError,
  type VariantDef,
  type VariantErrorCode,
  type VariantResolver,
  type VariantResolverOptions,
  type VariantTransform,
} from './variants.js';
