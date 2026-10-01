/**
 * Filesystem contract (`jsails/filesystem`): the keyed `Disk` surface, its
 * optional streaming and signed-URL capabilities, and the named `FileSystem`
 * service token. Implementations and the plugin live in
 * `@jsails/filesystem`.
 */

export {
  DiskError,
  isDisk,
  type Disk,
  type DiskData,
  type DiskErrorCode,
  type DiskPutOptions,
} from './disk.js';
export {
  DISK_URL_DEFAULT_EXPIRES_IN,
  DISK_URL_MAX_EXPIRES_IN,
  diskUrl,
  isUrlDisk,
  type DiskUrlOptions,
  type UrlDisk,
} from './signed-url.js';
export {
  DiskRangeError,
  isStreamingDisk,
  type DiskPutStreamOptions,
  type DiskRange,
  type DiskRangeErrorCode,
  type DiskReadStream,
  type DiskStreamOptions,
  type StreamingDisk,
} from './streaming.js';
export { filesystemToken, type FileSystem } from './service.js';
