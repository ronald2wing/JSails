/**
 * The archive reader's limits. The defaults are also ceilings: a caller may
 * tighten them (a test, a smaller upload form) but never raise them, so every
 * reader of a bundle holds the same bound on memory and work.
 */

import { ArchiveErrors } from './archive-errors.js';

/**
 * Bounds on one archive.
 *
 * @public
 */
export interface ArchiveLimits {
  /** Bytes of the gzip stream as received. */
  readonly maxCompressedBytes: number;
  /** Bytes the gzip stream inflates to: the whole tar stream, headers and padding included. */
  readonly maxExtractedBytes: number;
  /**
   * Entries: every file and directory header, repeats included. A metadata
   * header (pax, GNU long name) belongs to the entry it describes.
   */
  readonly maxEntries: number;
}

/**
 * The reader's ceilings: 16 MiB compressed, 64 MiB extracted, 2,000 entries.
 *
 * @public
 */
export const ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxCompressedBytes: 16 * 1024 * 1024,
  maxExtractedBytes: 64 * 1024 * 1024,
  maxEntries: 2_000,
});

const LIMIT_NAMES = ['maxCompressedBytes', 'maxExtractedBytes', 'maxEntries'] as const;

/**
 * The effective limits: the ceilings with each given limit in place of its
 * ceiling. Throws `bundle_archive.invalid_limits` for a limit that is not a
 * positive integer or exceeds its ceiling.
 */
export function resolveArchiveLimits(limits: Partial<ArchiveLimits> = {}): ArchiveLimits {
  const resolved = { ...ARCHIVE_LIMITS };
  for (const limit of LIMIT_NAMES) {
    const value = limits[limit];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > ARCHIVE_LIMITS[limit]) {
      throw new ArchiveErrors.Error('invalid_limits', { limit });
    }
    resolved[limit] = value;
  }
  return Object.freeze(resolved);
}
