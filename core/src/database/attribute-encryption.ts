/**
 * Attribute encryption: an entity hook bridge that encrypts named fields before
 * persistence and decrypts them after load.
 *
 * {@link encrypts} returns an {@link EntityHooksDefinition} gating
 * `beforeInsert`/`beforeUpdate` (encrypt), `afterInsert`/`afterUpdate` (restore
 * the plaintext on the caller's instance), and `afterLoad` (decrypt) on the
 * fields declared.  Wire it through {@link createEntitySubscriber} into a
 * {@link JsailsDataSource} `subscribers` array, exactly like
 * {@link entityValidationHooks}.
 *
 * The caller's instance holds plaintext before and after a save: the envelope
 * exists only for the duration of the write. Without the restore, a second
 * `save()` of the same instance would encrypt the stored envelope again and
 * corrupt the column. As a second guard, a value equal to the envelope this
 * bridge last wrote for that instance and field (a save that failed before its
 * after-hook ran) is mapped back to its plaintext rather than re-encrypted.
 *
 * Two modes are available:
 *
 * - **Non-deterministic (default)** — uses the caller-supplied {@link Encrypter}
 *   (AES-256-GCM, random IV). Ciphertext is different every call even for
 *   identical plaintext. The encrypted column is **not queryable by equality**.
 *
 * - **Deterministic** (`deterministic: true`) — uses a local AES-256-GCM cipher
 *   with a synthetic IV, so equal plaintexts always yield equal ciphertext and
 *   the column **is** queryable by equality ({@link encryptDeterministic}
 *   computes the value to compare against). This is opt-in because **equality
 *   of ciphertext leaks equality of plaintext**. A separate `deterministicKey`
 *   is required; the primary encrypter's key is never extracted.
 *
 * The deterministic cipher writes `v2` envelopes whose IV is
 * HMAC-SHA256(ivKey, aad, plaintext) truncated to 12 bytes, with `ivKey` and
 * the AES key derived from `deterministicKey` through HKDF under separate
 * labels. Keying the IV matters: the IV is stored in clear, and the legacy `v1`
 * construction (an unkeyed SHA-256 prefix of the plaintext) let anyone holding
 * a database dump test guessed values without the key. Binding the AAD into
 * the IV also means one key never reuses a GCM nonce across two AAD values.
 * Legacy `v1` envelopes still decrypt; they are rewritten as `v2` the next time
 * the field is written (see {@link encryptDeterministic} for a backfill).
 *
 * On decrypt failure (tampered or foreign ciphertext) the hook throws a
 * value-free {@link EncryptionError} (`decryption_failed`) — the field value
 * is never echoed.
 */

import { createHmac, hkdfSync } from 'node:crypto';
import type { EntityTarget, ObjectLiteral } from 'typeorm';

import {
  AES_GCM_IV_LENGTH,
  AES_GCM_KEY_LENGTH,
  deriveAesKey,
  openParsedEnvelope,
  parseEnvelope,
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

/** Options for {@link encryptDeterministic}; must match the hook bridge's. */
export interface DeterministicEncryptionOptions {
  readonly deterministicKey: string | Uint8Array;
  readonly aad?: string;
}

// -- deterministic cipher -----------------------------------------------------

/**
 * Domain separation for the deterministic cipher's string secrets. Distinct
 * from the Encrypter's salt so the same secret passed to both never produces
 * the same key material. The resulting key is the legacy `v1` AES key and the
 * input keying material for the `v2` keys.
 */
const DETERMINISTIC_KEY_DERIVATION: AesKeyDerivation = Object.freeze({
  salt: Buffer.from('jsails/attribute-encryption/det/v1', 'utf8'),
  info: Buffer.from('aes-256-gcm-det', 'utf8'),
  label: 'deterministic encryption key',
});

const V2_SALT = Buffer.from('jsails/attribute-encryption/det/v2', 'utf8');
const V2_ENCRYPTION_INFO = Buffer.from('aes-256-gcm-det-encryption', 'utf8');
const V2_IV_INFO = Buffer.from('hmac-sha256-det-synthetic-iv', 'utf8');

/** The key material of one deterministic cipher instance. */
interface DeterministicKeys {
  /** AES key of legacy `v1` envelopes (read-only). */
  readonly legacy: Buffer;
  /** AES key of `v2` envelopes. */
  readonly encryption: Buffer;
  /** HMAC key of the `v2` synthetic IV; never used for encryption. */
  readonly iv: Buffer;
}

function deriveDeterministicKeys(key: string | Uint8Array): DeterministicKeys {
  const legacy = deriveAesKey(key, DETERMINISTIC_KEY_DERIVATION);
  const expand = (info: Buffer): Buffer =>
    Buffer.from(hkdfSync('sha256', legacy, V2_SALT, info, AES_GCM_KEY_LENGTH));
  return { legacy, encryption: expand(V2_ENCRYPTION_INFO), iv: expand(V2_IV_INFO) };
}

/**
 * The `v2` synthetic IV: HMAC-SHA256 under the IV key over an unambiguous
 * encoding of (aad, plaintext), truncated to the GCM nonce length. Equal
 * inputs give equal IVs (that is what makes the cipher deterministic); without
 * the key the IV reveals nothing testable about the plaintext.
 */
function deriveSyntheticIv(ivKey: Buffer, plaintext: string, aad: string | undefined): Buffer {
  const mac = createHmac('sha256', ivKey);
  if (aad === undefined) {
    mac.update(Buffer.from([0]));
  } else {
    const aadBytes = Buffer.from(aad, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(aadBytes.length);
    mac.update(Buffer.from([1]));
    mac.update(length);
    mac.update(aadBytes);
  }
  mac.update(Buffer.from(plaintext, 'utf8'));
  return mac.digest().subarray(0, AES_GCM_IV_LENGTH);
}

function sealDeterministic(
  keys: DeterministicKeys,
  plaintext: string,
  aad: string | undefined,
): string {
  return sealEnvelope(
    keys.encryption,
    deriveSyntheticIv(keys.iv, plaintext, aad),
    plaintext,
    aad,
    'v2',
  );
}

function openDeterministic(
  keys: DeterministicKeys,
  token: string,
  aad: string | undefined,
): string {
  const envelope = parseEnvelope(token, ['v1', 'v2']);
  return openParsedEnvelope(
    envelope.version === 'v2' ? keys.encryption : keys.legacy,
    envelope,
    aad,
  );
}

/**
 * The ciphertext the deterministic hook bridge stores for `plaintext`, for an
 * equality query (`User.findOneBy({ email: encryptDeterministic(input, opts) })`)
 * or a backfill that rewrites legacy `v1` rows as `v2` through a query-builder
 * `update()`, which bypasses the hooks and so must write the envelope itself.
 * `options` must carry the same `deterministicKey` and `aad` as the bridge.
 */
export function encryptDeterministic(
  plaintext: string,
  options: DeterministicEncryptionOptions,
): string {
  if (typeof plaintext !== 'string') {
    throw new EncryptionError('invalid_options', 'plaintext must be a string');
  }
  return sealDeterministic(
    deriveDeterministicKeys(options.deterministicKey),
    plaintext,
    options.aad,
  );
}

// -- public API ---------------------------------------------------------------

/** The plaintext of one field and the envelope this bridge wrote for it. */
interface SealedField {
  readonly plaintext: string;
  readonly envelope: string;
}

/**
 * Build an entity hook definition that transparently encrypts and decrypts the
 * named fields.
 *
 * `beforeInsert` encrypts every non-empty-string value in `fields`;
 * `beforeUpdate` encrypts those among them the update changes (an unchanged
 * field is not rewritten); `afterInsert`/`afterUpdate` put the plaintext back
 * on the instance; `afterLoad` decrypts.  The hooks are synchronous — all
 * crypto operations use `node:crypto`'s synchronous APIs.
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

  const detKeys: DeterministicKeys | undefined =
    deterministic && options?.deterministicKey !== undefined
      ? deriveDeterministicKeys(options.deterministicKey)
      : undefined;

  if (deterministic && detKeys === undefined) {
    throw new EncryptionError(
      'invalid_options',
      'deterministicKey is required when deterministic is true',
    );
  }

  /**
   * Per instance, the fields sealed by the write in flight (or by a write that
   * failed before its after-hook). Weak, so an instance that is dropped takes
   * its plaintext with it.
   */
  const sealed = new WeakMap<object, Map<string, SealedField>>();

  const encryptValue = (value: string): string =>
    detKeys !== undefined
      ? sealDeterministic(detKeys, value, aad)
      : encrypter.encrypt(value, { aad });

  /** Encrypt fields on the instance being written (beforeInsert / beforeUpdate). */
  const encryptFields = (
    data: Record<string, unknown>,
    changedColumns: readonly string[] | undefined,
  ): void => {
    const previous = sealed.get(data);
    const current = new Map<string, SealedField>();
    for (const field of fields) {
      const value = data[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      const earlier = previous?.get(field);
      const plaintext =
        earlier !== undefined && earlier.envelope === value ? earlier.plaintext : value;
      if (changedColumns !== undefined && !changedColumns.includes(field)) {
        // Unchanged on this update: the column already holds this plaintext's
        // envelope, so the instance keeps its plaintext and nothing is written.
        data[field] = plaintext;
        continue;
      }
      const envelope = encryptValue(plaintext);
      data[field] = envelope;
      current.set(field, { plaintext, envelope });
    }
    sealed.set(data, current);
  };

  /** Put the plaintext back on the instance once the write is done. */
  const restoreFields = (data: Record<string, unknown>): void => {
    const current = sealed.get(data);
    if (current === undefined) return;
    sealed.delete(data);
    for (const [field, { plaintext, envelope }] of current) {
      if (data[field] === envelope) data[field] = plaintext;
    }
  };

  /** Decrypt fields on a data object (afterLoad). */
  const decryptFields = (data: Record<string, unknown>): void => {
    for (const field of fields) {
      const value = data[field];
      if (typeof value !== 'string' || value.length === 0) continue;

      try {
        data[field] =
          detKeys !== undefined
            ? openDeterministic(detKeys, value, aad)
            : encrypter.decrypt(value, { aad });
      } catch (err) {
        if (err instanceof EncryptionError) throw err;
        throw new EncryptionError('decryption_failed', 'decryption failed');
      }
    }
  };

  return defineEntityHooks<T>(entity, {
    beforeInsert({ data }) {
      encryptFields(data, undefined);
    },
    afterInsert({ data }) {
      restoreFields(data);
    },
    beforeUpdate({ data, changedColumns }) {
      encryptFields(data, changedColumns);
    },
    afterUpdate({ data }) {
      restoreFields(data);
    },
    afterLoad({ data }) {
      decryptFields(data);
    },
  });
}
