/**
 * The path rule for bundle entries, stricter than a POSIX tar reader needs,
 * because a bundle is extracted on Linux servers and on macOS and Windows
 * development machines alike and its file list is shown to an operator who
 * approves it.
 *
 * A name is UTF-8 (decoded with a fatal decoder). One leading `./` is dropped,
 * since `tar -C dir .` writes it. What remains must be relative, use forward
 * slashes only, and have no empty, `.`, `..` or `__proto__` segment, no
 * Windows drive, no C0 or C1 control character, no bidirectional formatting
 * character (which would let a listed name read as another), no character
 * Windows forbids in a name, no segment ending in a dot or a space and no
 * Windows device name (`CON`, `NUL.js`, `COM1`). A segment holds at most 255
 * UTF-8 bytes and a path at most 1,024 characters.
 *
 * {@link collisionKey} is the form two names collide in on a case-insensitive,
 * normalising file system, which the reader compares so two entries can never
 * land on one file.
 */

import { ArchiveErrors } from './archive-errors.js';
import { isWellFormedText } from './well-formed.js';

const MAX_PATH_LENGTH = 1_024;
const MAX_SEGMENT_BYTES = 255;

/** C0 and C1 controls, DEL, and the bidirectional formatting characters. */
const FORBIDDEN_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** Characters Windows forbids in a file name, and the backslash separator. */
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*\\]/;
/**
 * A segment whose stem (up to its first dot, trailing white space dropped) is a
 * Windows device name, whatever extension follows.
 */
const WINDOWS_DEVICE_SEGMENT =
  /(?:^|\/)(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])\s*(?:\.[^/]*)?(?:\/|$)/i;
/** An empty, `.`, `..` or `__proto__` segment. */
const RESERVED_SEGMENT = /(?:^|\/)(?:\.{1,2}|__proto__)?(?:\/|$)/;
/** A segment ending in a dot or a space. */
const TRAILING_DOT_OR_SPACE = /[. ](?:\/|$)/;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function unsafePath(): Error {
  return new ArchiveErrors.Error('unsafe_path');
}

/** Decode a raw entry name as UTF-8, refusing bytes that are not. */
export function decodeEntryName(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw unsafePath();
  }
}

/**
 * Whether every segment of well-formed `path` holds at most
 * {@link MAX_SEGMENT_BYTES} UTF-8 bytes, counted from its UTF-16 code units
 * without encoding it (a surrogate pair is one four-byte character).
 */
function segmentsFit(path: string): boolean {
  let bytes = 0;
  for (let index = 0; index < path.length; index += 1) {
    const unit = path.charCodeAt(index);
    if (unit === 0x2f) bytes = 0;
    else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > MAX_SEGMENT_BYTES) return false;
  }
  return true;
}

/**
 * The checked path of an entry, or `undefined` for the archive's own root
 * directory (`./`). A directory's single trailing slash is dropped; a file
 * name may not end in one. Throws `bundle_archive.unsafe_path`.
 */
export function checkEntryPath(name: string, kind: 'file' | 'directory'): string | undefined {
  let path = name.startsWith('./') ? name.slice(2) : name;
  if (kind === 'directory') {
    if (path === '' && name === './') return undefined;
    if (path.endsWith('/')) path = path.slice(0, -1);
  }
  if (path === '' || path.length > MAX_PATH_LENGTH || !isWellFormedText(path)) throw unsafePath();
  if (FORBIDDEN_CHARACTERS.test(path) || WINDOWS_RESERVED_CHARACTERS.test(path)) {
    throw unsafePath();
  }
  // Each rule scans the whole path once: no per-segment strings, so the work
  // is linear in a path's length however many segments it has.
  if (RESERVED_SEGMENT.test(path) || TRAILING_DOT_OR_SPACE.test(path)) throw unsafePath();
  if (WINDOWS_DEVICE_SEGMENT.test(path) || !segmentsFit(path)) throw unsafePath();
  return path;
}

/** One round of the fold: decomposed, upper-cased, lower-cased, recomposed. */
function foldOnce(path: string): string {
  return path.normalize('NFD').toUpperCase().toLowerCase().normalize('NFC');
}

/**
 * The form in which two entry paths collide on a case-insensitive,
 * normalising file system. Lower-casing alone misses how those file systems
 * fold case: APFS applies Unicode case folding to decomposed names (`ſ` is
 * `s`, `ς` is `σ`, `ß` is `ss`) and NTFS upper-cases each character (`ı` is
 * `I`). Upper-casing and then lower-casing joins all of these. The fold runs
 * twice because one character, `ẞ`, lower-cases to `ß`, which a second round
 * takes to `ss`; after two rounds the key is stable for every code point. The
 * key may join names no file system joins (the Kelvin sign and `k`), which
 * only refuses a bundle whose names are confusable anyway.
 */
export function collisionKey(path: string): string {
  return foldOnce(foldOnce(path));
}
