/**
 * Content digests: SHA-256 as 64 lowercase hex characters, with no algorithm
 * prefix. A digest names bundle bytes in release statements, revocation lists
 * and the content-addressed bundle store, where it is also a path segment, so
 * it stays free of `:`; a change of algorithm is a new statement version.
 */

import { createHash } from 'node:crypto';

/**
 * The shape of a digest.
 *
 * @public
 */
export const DIGEST_PATTERN: RegExp = /^[0-9a-f]{64}$/;

/**
 * The SHA-256 digest of `bytes`, lowercase hex.
 *
 * @public
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
