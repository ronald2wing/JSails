/**
 * The bundle archive reader: gzip-compressed tar (ustar, pax, GNU) to a map of
 * regular files under the bundle path rule, within fixed limits, refusing
 * links, devices, native addons and every reader-dependent tar feature with a
 * value-free `bundle_archive.*` code.
 */

export { ArchiveErrors } from './archive-errors.js';
export { ARCHIVE_LIMITS, type ArchiveLimits } from './limits.js';
export { readTarGz, type ArchiveFiles } from './tar-reader.js';
