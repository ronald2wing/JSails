/**
 * Filesystem contract (`jsails/filesystem`): the streaming `Disk` with SHA-256
 * from every write, the separate `DiskUrlSigner`, the `disk.*` error codes, the
 * key rules, the shared write pipeline for implementations, the buffered
 * `readBytes`/`readText` helpers, and the named `FileSystem` service token.
 * Implementations, the plugin and the conformance suite live in
 * `@jsails/filesystem`. Server-only.
 */

export {
  assertMaxBytes,
  assertRangeShape,
  meterByteSource,
  resolveDiskRange,
  throwIfDiskAborted,
  type MeteredByteSource,
  type MeterOptions,
} from './byte-source.js';
export {
  DISK_LIST_MAX_LIMIT,
  isDisk,
  type ByteSource,
  type Disk,
  type DiskListOptions,
  type DiskListPage,
  type DiskObject,
  type DiskRange,
  type DiskReadOptions,
  type DiskStat,
  type DiskWriteOptions,
  type DiskWriteResult,
} from './disk.js';
export { DiskErrors, type DiskOperation } from './disk-errors.js';
export { assertDiskKey, assertDiskPrefix, isDiskKey } from './disk-key.js';
export { readBytes, readText, type ReadBytesOptions } from './read-bytes.js';
export { filesystemToken, type FileSystem } from './service.js';
export { isSha256, type Sha256 } from './sha256.js';
export {
  isDiskUrlSigner,
  SIGNED_URL_MAX_EXPIRES_IN_MS,
  type SignedContentDisposition,
  type DiskSignedUrlOptions,
  type DiskUrlSigner,
} from './url-signer.js';
