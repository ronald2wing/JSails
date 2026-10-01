/**
 * The bundle archive reader: a gzip-compressed tar stream to a map of
 * regular files, with no file system access and no third-party code.
 *
 * It reads what real tools write for a bundle: POSIX ustar, pax (bsdtar, and
 * `git archive`'s global header) and GNU tar (long names). The reader is a
 * safety boundary first, so wherever two tar readers could extract the same
 * bytes differently it refuses instead of picking one reading:
 *
 * - pax `x` records apply `path` and `size` to the next entry; metadata
 *   keywords (times, owners, `comment`, vendor `SCHILY.*` and `LIBARCHIVE.*`)
 *   are ignored; `hdrcharset` (non-UTF-8 names) and `GNU.sparse.*` (content
 *   that only a sparse-aware reader rebuilds) are refused. An `x` header must
 *   be followed by the entry it describes.
 * - A pax `g` header is skipped, unless it carries a keyword that would change
 *   later entries in another reader (`path`, `size`, `linkpath`,
 *   `hdrcharset`, `GNU.sparse.*`), which is refused.
 * - GNU `L` long names are read; a GNU `K` long link name may only precede the
 *   link it names, which is then refused like any link.
 * - The ustar prefix field is joined only for POSIX headers (`ustar\0` `00`):
 *   GNU headers (`ustar  \0`) keep access and change times there.
 * - Names are UTF-8 and pass the bundle path rule (`entry-path.ts`); two names
 *   that would land on one file anywhere collide.
 * - Symbolic and hard links, devices, FIFOs, native addons (`.node`), sparse,
 *   multi-volume and vendor entries, and base-256 numbers are refused, each
 *   with its own code.
 * - Every header's checksum must match, sizes are plain octal, the archive
 *   must end with an end-of-archive block, and nothing but zeros may follow it.
 *
 * Limits (`limits.ts`) bound the compressed input, the inflated stream and the
 * entry count before any of it is held. Every failure is a value-free
 * `bundle_archive.*` error.
 */

import { gunzipSync } from 'node:zlib';

import { ArchiveErrors } from './archive-errors.js';
import { checkEntryPath, collisionKey, decodeEntryName } from './entry-path.js';
import { resolveArchiveLimits, type ArchiveLimits } from './limits.js';
import { parsePaxRecords } from './pax.js';

/**
 * The regular files of an archive, by bundle path, in archive order.
 *
 * @public
 */
export type ArchiveFiles = ReadonlyMap<string, Uint8Array>;

const BLOCK = 512;
const NAME = { offset: 0, length: 100 } as const;
const SIZE = { offset: 124, length: 12 } as const;
const CHECKSUM = { offset: 148, length: 8 } as const;
const TYPEFLAG = 156;
const MAGIC = { offset: 257, length: 8 } as const;
const PREFIX = { offset: 345, length: 155 } as const;

const POSIX_MAGIC = 'ustar\u000000';
const GNU_MAGIC = 'ustar  \u0000';

/** A GNU long name or long link payload larger than this is refused. */
const MAX_LONG_NAME_BYTES = 64 * 1024;

const REGULAR_FILE = new Set(['0', '\u0000', '7']);
const METADATA = new Set(['x', 'g', 'L', 'K']);
const DEVICE = new Set(['3', '4', '6']);
const PAX_UNSUPPORTED = /^(?:hdrcharset$|GNU\.sparse\.)/;
const PAX_GLOBAL_FORBIDDEN = /^(?:path$|size$|linkpath$|hdrcharset$|GNU\.sparse\.)/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/;

type HeaderFormat = 'posix' | 'gnu';

/** Metadata headers read since the last entry, waiting for the entry they describe. */
interface Pending {
  pax?: ReadonlyMap<string, string>;
  longName?: string;
  longLink?: true;
}

function latin1(block: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let index = offset; index < offset + length; index += 1) {
    text += String.fromCharCode(block[index] ?? 0);
  }
  return text;
}

/**
 * An octal header number, or `NaN`. Leading spaces, octal digits, then NUL or
 * space padding: `parseInt` alone would read `12x` as 10.
 */
function readOctal(block: Uint8Array, field: { offset: number; length: number }): number {
  const text = latin1(block, field.offset, field.length)
    .replace(/[\u0000 ]+$/, '')
    .replace(/^ +/, '');
  if (text === '') return 0;
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : Number.NaN;
}

/** The bytes of a NUL-terminated field, up to its first NUL. */
function fieldBytes(block: Uint8Array, offset: number, length: number): Uint8Array {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return end === -1 ? field : field.subarray(0, end);
}

function isZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function headerFormat(block: Uint8Array): HeaderFormat {
  const magic = latin1(block, MAGIC.offset, MAGIC.length);
  if (magic === POSIX_MAGIC) return 'posix';
  if (magic === GNU_MAGIC) return 'gnu';
  throw new ArchiveErrors.Error('invalid_header', { problem: 'magic' });
}

/**
 * The checksum is the sum of the header bytes with its own field read as
 * spaces; historic writers summed signed bytes, so either sum is accepted.
 */
function checkChecksum(block: Uint8Array): void {
  const stored = readOctal(block, CHECKSUM);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const inField = index >= CHECKSUM.offset && index < CHECKSUM.offset + CHECKSUM.length;
    const byte = inField ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (stored !== unsigned && stored !== signed) {
    throw new ArchiveErrors.Error('invalid_header', { problem: 'checksum' });
  }
}

function headerSize(block: Uint8Array): number {
  if (((block[SIZE.offset] ?? 0) & 0x80) !== 0) {
    throw new ArchiveErrors.Error('unsupported_archive_format');
  }
  const size = readOctal(block, SIZE);
  if (!Number.isSafeInteger(size)) {
    throw new ArchiveErrors.Error('invalid_header', { problem: 'size' });
  }
  return size;
}

function headerName(block: Uint8Array, format: HeaderFormat): string {
  const name = decodeEntryName(fieldBytes(block, NAME.offset, NAME.length));
  if (format === 'gnu') return name;
  const prefix = decodeEntryName(fieldBytes(block, PREFIX.offset, PREFIX.length));
  return prefix === '' ? name : `${prefix}/${name}`;
}

function longName(data: Uint8Array): string {
  if (data.length > MAX_LONG_NAME_BYTES) {
    throw new ArchiveErrors.Error('invalid_header', { problem: 'long_name' });
  }
  const end = data.indexOf(0);
  return decodeEntryName(end === -1 ? data : data.subarray(0, end));
}

function extendedHeader(data: Uint8Array): ReadonlyMap<string, string> {
  const records = parsePaxRecords(data);
  for (const keyword of records.keys()) {
    if (PAX_UNSUPPORTED.test(keyword)) throw new ArchiveErrors.Error('unsupported_archive_format');
  }
  const size = records.get('size');
  if (size !== undefined && !DECIMAL.test(size)) {
    throw new ArchiveErrors.Error('invalid_header', { problem: 'pax_record' });
  }
  return records;
}

function globalHeader(data: Uint8Array): void {
  for (const keyword of parsePaxRecords(data).keys()) {
    if (PAX_GLOBAL_FORBIDDEN.test(keyword)) {
      throw new ArchiveErrors.Error('unsupported_archive_format');
    }
  }
}

function inflate(bytes: Uint8Array, limits: ArchiveLimits): Uint8Array {
  if (bytes.byteLength > limits.maxCompressedBytes) {
    throw new ArchiveErrors.Error('too_large', { limit: 'compressed' });
  }
  try {
    return gunzipSync(bytes, { maxOutputLength: limits.maxExtractedBytes });
  } catch (error) {
    if (error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArchiveErrors.Error('too_large', { limit: 'extracted' });
    }
    throw new ArchiveErrors.Error('invalid_gzip');
  }
}

/**
 * Collects entries and refuses any two that would land on one file. Every
 * entry header, a directory or a repeat included, counts against `maxEntries`
 * before its name is checked, so the work spent on names is bounded by the
 * entry limit and not by how many tiny headers fit in the extracted size.
 */
class EntrySet {
  readonly files = new Map<string, Uint8Array>();
  readonly #fileKeys = new Set<string>();
  readonly #directoryKeys = new Set<string>();
  #count = 0;

  constructor(readonly maxEntries: number) {}

  /** Count one more entry header. */
  admit(): void {
    this.#count += 1;
    if (this.#count > this.maxEntries) throw new ArchiveErrors.Error('too_many_entries');
  }

  addFile(path: string, data: Uint8Array): void {
    const key = collisionKey(path);
    if (this.#fileKeys.has(key) || this.#directoryKeys.has(key)) {
      throw new ArchiveErrors.Error('duplicate_entry');
    }
    this.#fileKeys.add(key);
    // A copy, so no entry shares memory with the inflated stream or another entry.
    this.files.set(path, new Uint8Array(data));
  }

  addDirectory(path: string): void {
    const key = collisionKey(path);
    if (this.#fileKeys.has(key)) throw new ArchiveErrors.Error('duplicate_entry');
    this.#directoryKeys.add(key);
  }

  /**
   * A file that is also a directory of another entry is a collision. In
   * sorted order the keys under `file/` are one run, so a binary search for
   * where `file/` would sort finds one if any exists: the work is a sort and a
   * search per file, not a lookup for every prefix of every path.
   */
  checkPrefixes(): void {
    const ordered = [...this.#fileKeys, ...this.#directoryKeys].sort();
    for (const file of this.#fileKeys) {
      const under = `${file}/`;
      let low = 0;
      let high = ordered.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((ordered[middle] ?? '') < under) low = middle + 1;
        else high = middle;
      }
      if (ordered[low]?.startsWith(under) === true) {
        throw new ArchiveErrors.Error('duplicate_entry');
      }
    }
  }
}

function isNativeAddon(path: string): boolean {
  return path.toLowerCase().endsWith('.node');
}

/** Read one entry header (anything but a metadata header) into `entries`. */
function readEntry(
  typeflag: string,
  name: string,
  data: Uint8Array,
  pending: Pending,
  entries: EntrySet,
): void {
  entries.admit();
  if (typeflag === '1') throw new ArchiveErrors.Error('hardlink_entry');
  if (typeflag === '2') throw new ArchiveErrors.Error('symlink_entry');
  if (pending.longLink === true) throw new ArchiveErrors.Error('unsupported_archive_format');
  if (DEVICE.has(typeflag)) throw new ArchiveErrors.Error('device_entry');
  if (typeflag === '5') {
    if (data.length !== 0) throw new ArchiveErrors.Error('directory_with_content');
    const path = checkEntryPath(name, 'directory');
    if (path !== undefined) entries.addDirectory(path);
    return;
  }
  if (!REGULAR_FILE.has(typeflag)) throw new ArchiveErrors.Error('unsupported_archive_format');
  const path = checkEntryPath(name, 'file');
  if (path === undefined) throw new ArchiveErrors.Error('unsafe_path');
  if (isNativeAddon(path)) throw new ArchiveErrors.Error('native_addon_entry');
  entries.addFile(path, data);
}

function parseTar(tar: Uint8Array, maxEntries: number): ArchiveFiles {
  const entries = new EntrySet(maxEntries);
  let pending: Pending = {};
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > tar.length) throw new ArchiveErrors.Error('truncated');
    const block = tar.subarray(offset, offset + BLOCK);
    if (isZero(block)) {
      if (pending.pax !== undefined || pending.longName !== undefined || pending.longLink) {
        throw new ArchiveErrors.Error('truncated');
      }
      if (!isZero(tar.subarray(offset + BLOCK))) {
        throw new ArchiveErrors.Error('invalid_header', { problem: 'trailing_data' });
      }
      break;
    }
    const format = headerFormat(block);
    checkChecksum(block);
    const typeflag = String.fromCharCode(block[TYPEFLAG] ?? 0);
    const declared = headerSize(block);
    // A pax `size` describes the entry the `x` header precedes, never another
    // metadata header in between.
    const paxSize = METADATA.has(typeflag) ? undefined : pending.pax?.get('size');
    const size = paxSize === undefined ? declared : Number(paxSize);
    const start = offset + BLOCK;
    const next = start + Math.ceil(size / BLOCK) * BLOCK;
    if (next > tar.length) throw new ArchiveErrors.Error('truncated');
    const data = tar.subarray(start, start + size);

    if (typeflag === 'x') {
      if (pending.pax !== undefined || pending.longName !== undefined || pending.longLink) {
        throw new ArchiveErrors.Error('invalid_header', { problem: 'pax_record' });
      }
      pending.pax = extendedHeader(data);
    } else if (typeflag === 'g') {
      if (pending.pax !== undefined || pending.longName !== undefined || pending.longLink) {
        throw new ArchiveErrors.Error('invalid_header', { problem: 'pax_record' });
      }
      globalHeader(data);
    } else if (typeflag === 'L') {
      if (pending.pax !== undefined) throw new ArchiveErrors.Error('unsupported_archive_format');
      if (pending.longName !== undefined) {
        throw new ArchiveErrors.Error('invalid_header', { problem: 'long_name' });
      }
      pending.longName = longName(data);
    } else if (typeflag === 'K') {
      if (pending.longLink === true) {
        throw new ArchiveErrors.Error('invalid_header', { problem: 'long_name' });
      }
      longName(data);
      pending.longLink = true;
    } else {
      const name = pending.pax?.get('path') ?? pending.longName ?? headerName(block, format);
      readEntry(typeflag, name, data, pending, entries);
      pending = {};
    }
    offset = next;
  }
  entries.checkPrefixes();
  return entries.files;
}

/**
 * Inflate a gzip-compressed tar stream and read its regular files. Directory
 * entries are checked and then dropped. Throws a `bundle_archive.*` error for
 * any archive the module header describes as refused.
 *
 * @public
 */
export function readTarGz(bytes: Uint8Array, limits: Partial<ArchiveLimits> = {}): ArchiveFiles {
  const resolved = resolveArchiveLimits(limits);
  return parseTar(inflate(bytes, resolved), resolved.maxEntries);
}
