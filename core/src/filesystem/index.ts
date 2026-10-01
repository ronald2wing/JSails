/**
 * Filesystem contract (`jsails/filesystem`): the keyed `Disk` surface and the
 * named `FileSystem` service token. Implementations and the plugin live in
 * `@jsails/filesystem`.
 */

export {
  DiskError,
  type Disk,
  type DiskData,
  type DiskErrorCode,
  type DiskPutOptions,
} from './disk.js';
export { filesystemToken, type FileSystem } from './service.js';
