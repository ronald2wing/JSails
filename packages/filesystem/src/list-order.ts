/**
 * Key order and list cursors for the disks that page their own keys (memory
 * and local). Keys are ordered by their UTF-8 bytes, as S3 orders them, so a
 * listing reads the same on every disk; a cursor is the last key of a page,
 * base64url-encoded, and the next page starts strictly after it.
 */

import { DiskErrors, isDiskKey } from 'jsails/filesystem';

/** Compare two keys by their UTF-8 bytes. */
export function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The cursor that resumes a listing after `key`. */
export function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

/** The key a cursor resumes after; `disk.invalid_cursor` for one this module did not issue. */
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const key = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!isDiskKey(key) || encodeCursor(key) !== cursor) {
    throw new DiskErrors.Error('invalid_cursor');
  }
  return key;
}

/** True when `key` lies under `prefix` as a list or delete scope (`''` is every key). */
export function isUnderPrefix(key: string, prefix: string): boolean {
  return prefix === '' || key.startsWith(`${prefix}/`);
}
