/**
 * The archive reader's error codes, `bundle_archive.*`. Each names the one rule
 * an archive broke; no entry name, size or content reaches a message, because
 * the archive is untrusted input that an operator may later read in a log.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const ARCHIVE_ERRORS = {
  invalid_gzip: {
    kind: 'invalid',
    message: 'the bundle is not valid gzip data',
    suggestion: 'Upload the .tgz file the publisher released, unmodified',
  },
  invalid_header: {
    kind: 'invalid',
    message: 'an archive header is malformed: {problem}',
    context: {
      problem: ['magic', 'checksum', 'size', 'pax_record', 'long_name', 'trailing_data'],
    },
    suggestion: 'Rebuild the bundle with a POSIX (ustar or pax) or GNU tar writer',
  },
  truncated: {
    kind: 'invalid',
    message: 'the archive ends before its last entry or has no end-of-archive marker',
    suggestion: 'Download the bundle again; it was cut short',
  },
  unsafe_path: {
    kind: 'invalid',
    message: 'an archive entry has a path a bundle may not use',
    suggestion:
      'Use relative UTF-8 paths with forward slashes, no "." or ".." segments, no control or Windows-reserved characters, and no segment ending in a dot or space',
  },
  duplicate_entry: {
    kind: 'invalid',
    message: 'two archive entries name the same file',
    suggestion:
      'Give every file its own path; names that differ only in case or Unicode normalisation, and a file that is also a directory, collide',
  },
  symlink_entry: {
    kind: 'invalid',
    message: 'the archive contains a symbolic link',
    suggestion: 'Copy the target file into the bundle instead of linking to it',
  },
  hardlink_entry: {
    kind: 'invalid',
    message: 'the archive contains a hard link',
    suggestion: 'Store every file as a regular file',
  },
  device_entry: {
    kind: 'invalid',
    message: 'the archive contains a device or FIFO entry',
    suggestion: 'A bundle holds regular files and directories only',
  },
  native_addon_entry: {
    kind: 'invalid',
    message: 'the archive contains a native addon (.node file)',
    suggestion: 'Marketplace bundles are JavaScript only; ship native code as an npm package',
  },
  unsupported_archive_format: {
    kind: 'invalid',
    message: 'the archive uses a tar feature bundles do not support',
    suggestion:
      'Rebuild the bundle without sparse files, multi-volume or vendor entries, base-256 sizes, or a non-UTF-8 header charset',
  },
  directory_with_content: {
    kind: 'invalid',
    message: 'an archive directory entry carries data',
    suggestion: 'Rebuild the bundle with a standard tar writer',
  },
  too_many_entries: {
    kind: 'too_large',
    message: 'the archive holds more entries than the reader accepts',
    suggestion:
      'A bundle holds at most 2,000 entries, files and directories together; bundle the code into fewer modules',
  },
  too_large: {
    kind: 'too_large',
    message: 'the archive exceeds its {limit} size limit',
    context: { limit: ['compressed', 'extracted'] },
    suggestion: 'A bundle is at most 16 MiB compressed and 64 MiB extracted',
  },
  invalid_limits: {
    kind: 'internal',
    message: 'archive limit {limit} must be a positive integer no larger than its ceiling',
    context: { limit: ['maxCompressedBytes', 'maxExtractedBytes', 'maxEntries'] },
    suggestion:
      'Limits may only tighten the reader: 16 MiB compressed, 64 MiB extracted, 2,000 entries',
  },
} as const;

/**
 * The archive reader's codes, `bundle_archive.*`.
 *
 * @public
 */
export const ArchiveErrors: ErrorRegistry<'bundle_archive', typeof ARCHIVE_ERRORS> = defineErrors(
  'bundle_archive',
  ARCHIVE_ERRORS,
);
