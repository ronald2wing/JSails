/**
 * The AES-256-GCM primitive behind every JSails encryption envelope: key
 * derivation from a secret and the `v1.<iv>.<tag>.<ciphertext>` seal/open
 * pair, each part base64url-encoded without padding.
 *
 * {@link AesEncrypter} (random IV, key rotation) and the deterministic
 * attribute cipher (plaintext-derived IV) both build on this module so the
 * on-disk token format is defined once.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { EncryptionError } from './errors.js';

const AES_ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v1';
const ENVELOPE_SEPARATOR = '.';
const ENVELOPE_PARTS = 4;
const MIN_STRING_KEY_BYTES = 32;

/** The GCM nonce length in bytes. */
export const AES_GCM_IV_LENGTH = 12;

/** The AES-256 key length in bytes. */
export const AES_GCM_KEY_LENGTH = 32;

/**
 * How a string secret becomes a key. A fixed salt is correct here: the input
 * is a high-entropy secret, not a password, so the salt's only job is to
 * separate this derivation from any other use of the same secret. Two
 * derivations with different salts never share key material.
 */
export interface AesKeyDerivation {
  readonly salt: Buffer;
  readonly info: Buffer;
  /** Names the key in a rejection, e.g. `encryption key`. */
  readonly label: string;
}

/**
 * Validate a key and return the 32-byte buffer `createCipheriv` needs.
 *
 * A string key is utf8-encoded, must be at least 32 bytes, and yields a key
 * through HKDF-SHA256 so the full secret contributes (truncating would
 * silently discard entropy and let two secrets sharing a prefix collide). A
 * `Uint8Array` key must be exactly 32 bytes and is used verbatim.
 */
export function deriveAesKey(key: string | Uint8Array, derivation: AesKeyDerivation): Buffer {
  if (typeof key === 'string') {
    if (Buffer.byteLength(key, 'utf8') < MIN_STRING_KEY_BYTES) {
      throw new EncryptionError('invalid_key', `${derivation.label} must be at least 32 bytes`);
    }
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(key, 'utf8'),
        derivation.salt,
        derivation.info,
        AES_GCM_KEY_LENGTH,
      ),
    );
  }

  if (key instanceof Uint8Array) {
    if (key.byteLength !== AES_GCM_KEY_LENGTH) {
      throw new EncryptionError('invalid_key', `${derivation.label} must be exactly 32 bytes`);
    }
    return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
  }

  throw new EncryptionError('invalid_key', `${derivation.label} must be a string or Uint8Array`);
}

/** A fresh random GCM nonce. */
export function randomAesIv(): Buffer {
  return randomBytes(AES_GCM_IV_LENGTH);
}

/** Encrypt `plaintext` under `keyBytes` with the given IV and return the envelope string. */
export function sealEnvelope(
  keyBytes: Buffer,
  iv: Buffer,
  plaintext: string,
  aad: string | undefined,
): string {
  const cipher = createCipheriv(AES_ALGORITHM, keyBytes, iv);
  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(ENVELOPE_SEPARATOR);
}

/** The decoded parts of an envelope, ready for decryption under any candidate key. */
export interface SealedEnvelope {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Split and decode an envelope string. A token without exactly four parts or
 * with undecodable parts is `invalid_token`; a version other than `v1` is
 * `unsupported_version`. Neither message carries the token.
 */
export function parseEnvelope(token: string): SealedEnvelope {
  const parts = token.split(ENVELOPE_SEPARATOR);
  if (parts.length !== ENVELOPE_PARTS) {
    throw new EncryptionError('invalid_token', 'invalid encryption token');
  }
  if (parts[0] !== ENVELOPE_VERSION) {
    throw new EncryptionError('unsupported_version', 'unsupported encryption token version');
  }
  return {
    iv: decodeEnvelopePart(parts[1]!),
    tag: decodeEnvelopePart(parts[2]!),
    ciphertext: decodeEnvelopePart(parts[3]!),
  };
}

/**
 * Decode a base64url envelope part. `Buffer.from` silently skips invalid
 * characters and can return an empty buffer for entirely non-base64url input;
 * a well-formed IV, tag, or ciphertext is never zero-length, so that case is
 * rejected as `invalid_token`.
 */
function decodeEnvelopePart(part: string): Buffer {
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.length === 0 && part.length > 0) {
    throw new EncryptionError('invalid_token', 'invalid encryption token');
  }
  return bytes;
}

/**
 * Decrypt a parsed envelope under one key. Authentication failure surfaces as
 * the underlying `node:crypto` error so a rotation loop can try the next key;
 * {@link openEnvelope} is the single-key form with the value-free code.
 */
export function decryptEnvelope(
  keyBytes: Buffer,
  envelope: SealedEnvelope,
  aad: string | undefined,
): string {
  const decipher = createDecipheriv(AES_ALGORITHM, keyBytes, envelope.iv);
  decipher.setAuthTag(envelope.tag);
  if (aad !== undefined) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
}

/** Parse and decrypt an envelope under one key; a key or tag mismatch is `decryption_failed`. */
export function openEnvelope(keyBytes: Buffer, token: string, aad: string | undefined): string {
  const envelope = parseEnvelope(token);
  try {
    return decryptEnvelope(keyBytes, envelope, aad);
  } catch {
    throw new EncryptionError('decryption_failed', 'decryption failed');
  }
}
