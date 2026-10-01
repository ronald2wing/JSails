/**
 * Minimal, dependency-free `.tgz` extractor for plugin bundles.
 *
 * `extractTarGz` gunzips a gzip-compressed tar stream (`node:zlib`) and parses
 * the ustar tar format directly: a 512-byte header per entry followed by its
 * padded data. It returns a deterministic `Map` of portable relative path ->
 * file contents and never touches the filesystem — the caller owns every write.
 *
 * The extractor is a safety boundary, not a general-purpose tar reader:
 *
 * - Every entry name is validated through the shared portable-path guard
 *   (`assertPortablePath`): absolute POSIX/UNC paths, Windows drive paths,
 *   backslashes, Windows-reserved characters, empty/`.`/`..`/`__proto__`
 *   segments, and control characters are all refused.
 * - Symbolic links, hard links, character/block devices, and FIFOs are refused,
 *   as are directories that carry content.
 * - Extraction is bounded (`maxEntries`, `maxTotalBytes`) so an archive that
 *   expands hugely is rejected before it can exhaust memory.
 * - Every header's checksum field must match the header bytes, and every size
 *   field must be plain octal digits, so a malformed header cannot shift the
 *   entry boundaries and silently change the extracted contents.
 * - Only regular files, directories, and the GNU long-name marker (`L`) are
 *   understood. PAX extended headers (`x`/`g`), GNU long-link markers (`K`),
 *   and any other entry type are refused rather than silently skipped.
 *
 * Every failure raises a value-free {@link ArchiveError}: the entry name, file
 * contents, and any other input are never echoed.
 */

import { gunzipSync } from 'node:zlib';

import { assertPortablePath, PortablePathError } from '../support/portable-path.js';
import { JsailsError } from '../errors/jsails-error.js';

/** Default cap on the number of entries an archive may declare. */
export const DEFAULT_MAX_ENTRIES = 1000;

/** Default cap on the total uncompressed bytes an archive may expand to. */
export const DEFAULT_MAX_TOTAL_BYTES: number = 64 * 1024 * 1024;

/** Options for {@link extractTarGz}. */
export interface ExtractTarGzOptions {
  /** Maximum number of regular-file entries to accept. Defaults to 1000. */
  readonly maxEntries?: number;
  /** Maximum total uncompressed bytes to accept. Defaults to 64 MiB. */
  readonly maxTotalBytes?: number;
}

/** Stable machine code carried by every {@link ArchiveError}. */
export type ArchiveErrorCode =
  | 'invalid_gzip'
  | 'invalid_header'
  | 'truncated'
  | 'unsafe_path'
  | 'duplicate_entry'
  | 'symlink'
  | 'hardlink'
  | 'device'
  | 'directory_with_content'
  | 'unsupported_entry_type'
  | 'too_many_entries'
  | 'too_large'
  | 'invalid_options';

/** Raised when an archive fails to gunzip or contains an unsafe/invalid entry. */
export class ArchiveError extends JsailsError {
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Tar record size: both a header and a unit of data padding. */
const BLOCK_SIZE = 512;

/** Header field offsets and lengths (ustar layout). */
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const TYPEFLAG_OFFSET = 156;
const MAGIC_OFFSET = 257;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

/** Type flags treated as a regular file. */
const REGULAR_FILE_TYPES = new Set(['0', '\0', '7']);
/** Type flag for a directory. */
const DIRECTORY_TYPE = '5';
/** GNU long-name marker: its data is the next entry's name. */
const GNU_LONG_NAME_TYPE = 'L';

/**
 * Gunzip `data` and extract its tar entries. See the module doc for the exact
 * safety contract. Throws {@link ArchiveError} on any invalid input.
 */
export function extractTarGz(
  data: Uint8Array,
  options: ExtractTarGzOptions = {},
): Map<string, Uint8Array> {
  const { maxEntries, maxTotalBytes } = resolveOptions(options);

  let inflated: Uint8Array;
  try {
    inflated = gunzipSync(data, { maxOutputLength: maxTotalBytes });
  } catch (error) {
    if (isTooLargeError(error)) {
      throw new ArchiveError('too_large', 'archive expands beyond the size limit');
    }
    throw new ArchiveError('invalid_gzip', 'archive is not valid gzip data');
  }

  return parseTar(inflated, maxEntries);
}

/** Parse a decompressed ustar stream into a deterministic file map. */
function parseTar(inflated: Uint8Array, maxEntries: number): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  let entryCount = 0;
  let pendingName: string | null = null;

  while (offset + BLOCK_SIZE <= inflated.length) {
    const block = inflated.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(block)) {
      break; // end-of-archive marker.
    }

    assertUstarMagic(block);
    assertHeaderChecksum(block);

    const typeflag = String.fromCharCode(block[TYPEFLAG_OFFSET] ?? 0);
    const size = readOctal(block, SIZE_OFFSET, SIZE_LENGTH);
    if (!Number.isInteger(size) || size < 0) {
      throw new ArchiveError('invalid_header', 'archive entry has an invalid size');
    }

    const name = pendingName ?? readName(block);
    pendingName = null;

    offset += BLOCK_SIZE;
    const dataBlocks = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (offset + dataBlocks > inflated.length) {
      throw new ArchiveError('truncated', 'archive is truncated');
    }

    if (typeflag === GNU_LONG_NAME_TYPE) {
      pendingName = readLongName(inflated, offset, size);
    } else if (REGULAR_FILE_TYPES.has(typeflag)) {
      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new ArchiveError('too_many_entries', 'archive contains too many entries');
      }
      assertPortableEntryName(name);
      if (entries.has(name)) {
        throw new ArchiveError('duplicate_entry', 'archive contains a duplicate entry');
      }
      // A view, not a copy: the inflated buffer is retained by every entry
      // anyway, so copying would double peak memory for no isolation gain.
      entries.set(name, inflated.subarray(offset, offset + size));
    } else if (typeflag === DIRECTORY_TYPE) {
      if (size !== 0) {
        throw new ArchiveError('directory_with_content', 'archive directory carries content');
      }
      assertPortableEntryName(normalizeDirectoryName(name));
    } else {
      throw unsupportedTypeError(typeflag);
    }

    offset += dataBlocks;
  }

  if (offset < inflated.length && !isZeroBlock(inflated.subarray(offset))) {
    throw new ArchiveError('truncated', 'archive is truncated');
  }

  return entries;
}

/** Map a rejected entry type to its value-free {@link ArchiveError}. */
function unsupportedTypeError(typeflag: string): ArchiveError {
  switch (typeflag) {
    case '1':
      return new ArchiveError('hardlink', 'archive contains a hard link');
    case '2':
      return new ArchiveError('symlink', 'archive contains a symbolic link');
    case '3':
    case '4':
    case '6':
      return new ArchiveError('device', 'archive contains a device or FIFO');
    default:
      return new ArchiveError('unsupported_entry_type', 'archive contains an unsupported entry');
  }
}

/** Validate an entry name through the portable-path guard, value-free on failure. */
function assertPortableEntryName(name: string): void {
  try {
    assertPortablePath(name);
  } catch (error) {
    if (error instanceof PortablePathError) {
      throw new ArchiveError('unsafe_path', 'archive entry has an unsafe path');
    }
    throw error;
  }
}

/** Strip a single trailing slash from a directory entry name. */
function normalizeDirectoryName(name: string): string {
  return name.endsWith('/') ? name.slice(0, -1) : name;
}

/** Read a header field, trimming trailing NULs and spaces. */
function readField(block: Uint8Array, offset: number, length: number): string {
  let end = offset + length;
  while (end > offset) {
    const byte = block[end - 1] ?? 0;
    if (byte === 0 || byte === 0x20) {
      end -= 1;
    } else {
      break;
    }
  }
  let result = '';
  for (let i = offset; i < end; i += 1) {
    result += String.fromCharCode(block[i] ?? 0);
  }
  return result;
}

/**
 * Read an octal ASCII field into a non-negative integer, or `NaN` if invalid.
 * Only leading spaces, octal digits, and trailing NUL/space padding are
 * accepted: `parseInt` alone would read `12x` as 10, and a GNU base-256 value
 * is not supported.
 */
function readOctal(block: Uint8Array, offset: number, length: number): number {
  const field = readField(block, offset, length).replace(/^ +/, '');
  if (field === '') return 0;
  if (!/^[0-7]+$/.test(field)) return NaN;
  return parseInt(field, 8);
}

/**
 * Verify the header checksum: the sum of all header bytes with the checksum
 * field itself counted as spaces. Historic writers summed signed bytes, so
 * either sum is accepted.
 */
function assertHeaderChecksum(block: Uint8Array): void {
  const stored = readOctal(block, CHECKSUM_OFFSET, CHECKSUM_LENGTH);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    const inField = i >= CHECKSUM_OFFSET && i < CHECKSUM_OFFSET + CHECKSUM_LENGTH;
    const byte = inField ? 0x20 : (block[i] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (!Number.isInteger(stored) || (stored !== unsigned && stored !== signed)) {
    throw new ArchiveError('invalid_header', 'archive entry has an invalid header checksum');
  }
}

/** Combine the ustar `prefix` and `name` fields into the full entry name. */
function readName(block: Uint8Array): string {
  const name = readField(block, NAME_OFFSET, NAME_LENGTH);
  const prefix = readField(block, PREFIX_OFFSET, PREFIX_LENGTH);
  return prefix === '' ? name : `${prefix}/${name}`;
}

/** Read a GNU long-name payload (NUL-terminated within its data). */
function readLongName(inflated: Uint8Array, offset: number, size: number): string {
  let end = offset + size;
  while (end > offset && (inflated[end - 1] ?? 0) === 0) {
    end -= 1;
  }
  let result = '';
  for (let i = offset; i < end; i += 1) {
    result += String.fromCharCode(inflated[i] ?? 0);
  }
  return result;
}

/** Reject any header whose magic field is not the ustar signature. */
function assertUstarMagic(block: Uint8Array): void {
  const magic = readField(block, MAGIC_OFFSET, 5);
  if (magic !== 'ustar') {
    throw new ArchiveError('invalid_header', 'archive entry has an invalid header');
  }
}

/** Whether every byte in `bytes` is zero. */
function isZeroBlock(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/** Whether `error` is a Node error for exceeding the gunzip output bound. */
function isTooLargeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
  );
}

/** Resolve and validate the extraction limits. */
function resolveOptions(options: ExtractTarGzOptions): {
  maxEntries: number;
  maxTotalBytes: number;
} {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new ArchiveError('invalid_options', 'maxEntries must be a positive integer');
  }
  if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new ArchiveError('invalid_options', 'maxTotalBytes must be a positive integer');
  }
  return { maxEntries, maxTotalBytes };
}
