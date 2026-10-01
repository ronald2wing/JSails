/**
 * Disk key/data validators used by the filesystem implementations.
 */

import { DiskError, type DiskData } from 'jsails/filesystem';
import { CONTROL_CHARS } from 'jsails/support';

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/**
 * Reject any key that is not a relative POSIX-style path. Conservative: empty,
 * absolute, drive-prefixed, backslashed, control-bearing, and any
 * empty/`.`/`..` segment are all refused with a value-free `DiskError` (the key
 * is never echoed).
 */
export function assertDiskKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new DiskError('invalid_key', 'disk keys must be non-empty strings');
  }
  if (CONTROL_CHARS.test(key)) {
    throw new DiskError('invalid_key', 'disk keys must not contain control characters');
  }
  if (key.includes('\\')) {
    throw new DiskError('invalid_key', 'disk keys must use forward slashes');
  }
  if (key.startsWith('/') || WINDOWS_DRIVE.test(key)) {
    throw new DiskError('invalid_key', 'disk keys must be relative POSIX paths');
  }
  for (const segment of key.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new DiskError('invalid_key', 'disk keys must not contain empty, ".", or ".." segments');
    }
  }
}

/** Validate a `list` prefix: `undefined`/`''` means "all", otherwise a valid key. */
export function assertDiskPrefix(prefix: unknown): asserts prefix is string | undefined {
  if (prefix === undefined || prefix === '') {
    return;
  }
  assertDiskKey(prefix);
}

/** Normalize accepted `put` data to bytes (a UTF-8 encode for strings). */
export function toDiskBytes(data: DiskData): Uint8Array {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  return data;
}

/** Validate the advisory `contentType`, when supplied. */
export function assertContentType(contentType: unknown): void {
  if (contentType === undefined) {
    return;
  }
  if (typeof contentType !== 'string' || contentType.trim() === '') {
    throw new TypeError('contentType must be a non-empty string');
  }
}

/** Validate a `maxBytes` option: `undefined` or a non-negative integer. */
export function validateMaxBytes(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new TypeError('maxBytes must be a non-negative integer');
  }
  return value;
}
