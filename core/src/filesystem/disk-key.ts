/**
 * The key rules every {@link Disk} applies: a key is a relative path of
 * `/`-separated segments, the same on every disk and every platform, so a key
 * written to a local directory can be moved to an object store unchanged.
 *
 * A key is refused when it is empty or longer than 1024 UTF-16 units, holds a
 * control character (C0, DEL or C1) or a backslash, starts with `/` or a drive
 * prefix (`C:`), or has an empty, `.` or `..` segment. A prefix (for `list`
 * and `deletePrefix`) follows the same rules.
 */

import { DiskErrors } from './disk-errors.js';

const MAX_KEY_LENGTH = 1024;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const DRIVE = /^[A-Za-z]:/;

/**
 * True when `key` satisfies the disk key rules.
 *
 * @public
 */
export function isDiskKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (CONTROL.test(key) || key.includes('\\') || key.startsWith('/') || DRIVE.test(key)) {
    return false;
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

/**
 * Throw `disk.invalid_key` unless `key` satisfies the disk key rules. The key
 * is never echoed.
 *
 * @public
 */
export function assertDiskKey(key: unknown): asserts key is string {
  if (!isDiskKey(key)) throw new DiskErrors.Error('invalid_key');
}

/**
 * Throw `disk.invalid_key` unless `prefix` is `''` (every key) or a valid key.
 *
 * @public
 */
export function assertDiskPrefix(prefix: unknown): asserts prefix is string {
  if (prefix === '') return;
  assertDiskKey(prefix);
}
