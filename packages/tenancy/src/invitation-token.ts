/**
 * Single-use invitation tokens.
 *
 * A token is `jsinv_` followed by the unpadded base64url encoding of 32 random
 * bytes (256 bits) from the platform CSPRNG. It is handed out once, to the
 * inviter's mailer and the caller; only its SHA-256 digest is stored, so a
 * leaked store cannot be turned back into working links.
 *
 * {@link hashInvitationToken} parses strictly before hashing: the prefix, the
 * exact length and the canonical encoding of the final character are all
 * required, and anything else yields `null` without throwing, so a malformed
 * link is indistinguishable from an unknown one. The prefix makes tokens easy
 * to recognise for secret scanners.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** The token prefix. */
export const INVITATION_TOKEN_PREFIX = 'jsinv_';

/** Random bytes per token. */
export const INVITATION_TOKEN_BYTES = 32;

const TOKEN_SHAPE = /^jsinv_[A-Za-z0-9_-]{43}$/;

/** A freshly issued token and the digest to store. */
export interface IssuedInvitationToken {
  readonly token: string;
  /** SHA-256 of the token's UTF-8 bytes; 32 bytes. */
  readonly hash: Uint8Array;
}

function digest(token: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
}

/** Issue a new invitation token with its SHA-256 digest. */
export function issueInvitationToken(): IssuedInvitationToken {
  const token = `${INVITATION_TOKEN_PREFIX}${randomBytes(INVITATION_TOKEN_BYTES).toString('base64url')}`;
  return Object.freeze({ token, hash: digest(token) });
}

/** The SHA-256 digest of a well-formed token, or `null` for anything else. */
export function hashInvitationToken(token: string): Uint8Array | null {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) {
    return null;
  }
  const body = token.slice(INVITATION_TOKEN_PREFIX.length);
  // 43 characters carry 258 bits; the last two must be zero for the encoding
  // of 32 bytes to be canonical, so exactly one spelling is accepted.
  if (Buffer.from(body, 'base64url').toString('base64url') !== body) {
    return null;
  }
  return digest(token);
}

/** Constant-time equality of two token digests; `false` for differing lengths. */
export function sameInvitationTokenHash(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
