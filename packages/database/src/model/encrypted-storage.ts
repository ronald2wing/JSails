/**
 * How an encrypted column is stored: as portable `binary`, sized to hold the
 * envelope of the longest plaintext the column accepts. The envelope (DAT-10)
 * is `0x03 | keyIdLength | keyId | iv(12) | ciphertext | tag(16)`, and
 * AES-GCM ciphertext is as long as its plaintext, so the stored size is the
 * plaintext capacity plus a fixed overhead that budgets the longest key id.
 */

import type { EncryptionSpec } from './model-spec.js';
import { plaintextBytes, type BinaryType, type PortableType } from './portable-type.js';

/** The longest key id a keyring may use, in bytes; the envelope budgets this much. */
export const ENCRYPTION_KEY_ID_MAX_BYTES = 32;

/** Envelope bytes around the ciphertext: version, key id length, key id, IV and tag. */
export const ENCRYPTION_ENVELOPE_OVERHEAD: number = 1 + 1 + ENCRYPTION_KEY_ID_MAX_BYTES + 12 + 16;

/** The plaintext capacity of an encrypted column, in UTF-8 bytes, or `undefined` if unbounded. */
export function encryptedCapacity(
  type: PortableType,
  encrypted: EncryptionSpec,
): number | undefined {
  return encrypted.maxLength ?? plaintextBytes(type);
}

/** The portable type an encrypted column is stored as. */
export function encryptedStorage(type: PortableType, encrypted: EncryptionSpec): BinaryType {
  const capacity = encryptedCapacity(type, encrypted);
  return capacity === undefined
    ? { kind: 'binary' }
    : { kind: 'binary', length: capacity + ENCRYPTION_ENVELOPE_OVERHEAD };
}
