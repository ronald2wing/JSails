/**
 * Attribute encryption: an entity hook bridge that encrypts named fields before
 * persistence and decrypts them after load.
 *
 * {@link encrypts} returns an {@link EntityHooksDefinition} gating
 * `beforeInsert`/`beforeUpdate` (encrypt) and `afterLoad` (decrypt) on the
 * fields declared.  Wire it through {@link createEntitySubscriber} into a
 * {@link JsailsDataSource} `subscribers` array, exactly like
 * {@link entityValidationHooks}.
 *
 * Two modes are available:
 *
 * - **Non-deterministic (default)** — uses the caller-supplied {@link Encrypter}
 *   (AES-256-GCM, random IV). Ciphertext is different every call even for
 *   identical plaintext. The encrypted column is **not queryable by equality**.
 *
 * - **Deterministic** (`deterministic: true`) — uses a local AES-256-GCM cipher
 *   whose IV is derived from the plaintext (SHA-256 → first 12 bytes), so equal
 *   plaintexts always yield equal ciphertext and the column **is** queryable by
 *   equality.  This is opt-in because **equality of ciphertext leaks equality of
 *   plaintext**.  A separate `deterministicKey` is required; the primary
 *   encrypter's key is never extracted.
 *
 * On decrypt failure (tampered or foreign ciphertext) the hook throws a
 * value-free {@link EncryptionError} (`decryption_failed`) — the field value
 * is never echoed.
 */

import { createHash } from 'node:crypto';
import type { EntityTarget, ObjectLiteral } from 'typeorm';

import {
  AES_GCM_IV_LENGTH,
  deriveAesKey,
  openEnvelope,
  sealEnvelope,
  type AesKeyDerivation,
} from '../encryption/aes-gcm.js';
import { EncryptionError } from '../encryption/errors.js';
import type { Encrypter } from '../encryption/encrypter-types.js';
import { defineEntityHooks, type EntityHooksDefinition } from './entity-subscribers.js';

// -- types --------------------------------------------------------------------

/** Options controlling the {@link encrypts} hook bridge. */
export interface EncryptsOptions {
  /**
   * When `true`, a local deterministic cipher is used so equal plaintexts
   * produce equal ciphertext (equality-queryable).  Defaults to `false`
   * (non-deterministic, random IV).
   */
  readonly deterministic?: boolean;

  /**
   * Additional authenticated data bound to every encrypt/decrypt call.
   * Must match on both sides; a mismatch fails decryption.
   */
  readonly aad?: string;

  /**
   * The key for the **deterministic** cipher path.  Required when
   * `deterministic` is `true`; ignored otherwise.  A string must be at least
   * 32 bytes (a 32-byte AES key is derived via HKDF-SHA256); a `Uint8Array`
   * must be exactly 32 bytes.
   */
  readonly deterministicKey?: string | Uint8Array;
}

// -- deterministic cipher -----------------------------------------------------

/**
 * Domain separation for the deterministic cipher's string secrets. Distinct
 * from the Encrypter's salt so the same secret passed to both never produces
 * the same key material.
 */
const DETERMINISTIC_KEY_DERIVATION: AesKeyDerivation = Object.freeze({
  salt: Buffer.from('jsails/attribute-encryption/det/v1', 'utf8'),
  info: Buffer.from('aes-256-gcm-det', 'utf8'),
  label: 'deterministic encryption key',
});

/**
 * Derive a fixed 12-byte IV from the plaintext.  SHA-256(plaintext)[0:12].
 * This is what makes the cipher deterministic: the same plaintext always
 * produces the same IV, and AES-256-GCM with the same (key, IV, plaintext, AAD)
 * always produces the same ciphertext.
 *
 * Security note: reusing a (key, IV) pair for different plaintexts in GCM
 * leaks the XOR of the plaintexts.  This is an accepted risk for deterministic
 * attribute-level encryption — the caller opts in and the field is equality-
 * queryable precisely because ciphertext equality reveals plaintext equality.
 */
function deriveDeterministicIv(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext, 'utf8').digest().subarray(0, AES_GCM_IV_LENGTH);
}

// -- public API ---------------------------------------------------------------

/**
 * Build an entity hook definition that transparently encrypts and decrypts the
 * named fields.
 *
 * `beforeInsert` and `beforeUpdate` encrypt every non-empty-string value in
 * `fields`; `afterLoad` decrypts them.  The hooks are synchronous — all crypto
 * operations use `node:crypto`'s synchronous APIs.
 *
 * @param entity  - The TypeORM entity target (class, `EntitySchema`, or name).
 * @param encrypter - The non-deterministic {@link Encrypter} (AES-256-GCM).
 * @param fields  - Field names to encrypt/decrypt.
 * @param options - Optional encryption mode and AAD.
 * @throws {EncryptionError} (`invalid_options`) when `fields` is empty or
 *         `deterministic: true` is set without `deterministicKey`.
 * @throws {EncryptionError} (`decryption_failed`) on afterLoad when a stored
 *         ciphertext cannot be decrypted — value-free, field value never echoed.
 */
export function encrypts<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  encrypter: Encrypter,
  fields: readonly string[],
  options?: EncryptsOptions,
): EntityHooksDefinition<T> {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new EncryptionError('invalid_options', 'fields must be a non-empty array');
  }

  const deterministic = options?.deterministic ?? false;
  const aad = options?.aad;

  const detKeyBytes: Buffer | undefined =
    deterministic && options?.deterministicKey !== undefined
      ? deriveAesKey(options.deterministicKey, DETERMINISTIC_KEY_DERIVATION)
      : undefined;

  if (deterministic && detKeyBytes === undefined) {
    throw new EncryptionError(
      'invalid_options',
      'deterministicKey is required when deterministic is true',
    );
  }

  /** Encrypt fields on a data object (beforeInsert / beforeUpdate). */
  const encryptFields = (data: Record<string, unknown>): void => {
    for (const field of fields) {
      const value = data[field];
      if (typeof value !== 'string' || value.length === 0) continue;

      data[field] = deterministic
        ? sealEnvelope(detKeyBytes!, deriveDeterministicIv(value), value, aad)
        : encrypter.encrypt(value, { aad });
    }
  };

  /** Decrypt fields on a data object (afterLoad). */
  const decryptFields = (data: Record<string, unknown>): void => {
    for (const field of fields) {
      const value = data[field];
      if (typeof value !== 'string' || value.length === 0) continue;

      try {
        data[field] = deterministic
          ? openEnvelope(detKeyBytes!, value, aad)
          : encrypter.decrypt(value, { aad });
      } catch (err) {
        if (err instanceof EncryptionError) throw err;
        throw new EncryptionError('decryption_failed', 'decryption failed');
      }
    }
  };

  return defineEntityHooks<T>(entity, {
    beforeInsert({ data }) {
      encryptFields(data);
    },
    beforeUpdate({ data }) {
      encryptFields(data);
    },
    afterLoad({ data }) {
      decryptFields(data);
    },
  });
}
