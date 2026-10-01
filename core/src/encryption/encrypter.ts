/**
 * Encrypter adapter: symmetric AES-256-GCM encryption and decryption with key
 * rotation support.
 *
 * Construct once with `new AesEncrypter(options)` — construction validates every
 * key eagerly, and the resulting instance is inert (`encrypt`/`decrypt` use
 * `node:crypto` on every call). The envelope format is
 * `v1.<iv>.<tag>.<ciphertext>` where each part is base64url-encoded without
 * padding.
 *
 * A string key is a high-entropy secret of at least 32 bytes from which a
 * 32-byte AES key is derived with HKDF-SHA256; a `Uint8Array` key is used
 * verbatim and must be exactly 32 bytes.
 */

import {
  decryptEnvelope,
  deriveAesKey,
  parseEnvelope,
  randomAesIv,
  sealEnvelope,
  type AesKeyDerivation,
} from './aes-gcm.js';
import { EncryptionError } from './errors.js';
import type {
  DecryptOptions,
  EncryptOptions,
  Encrypter,
  EncrypterOptions,
} from './encrypter-types.js';
import { isRecord } from '../json/shape.js';

// -- key derivation --------------------------------------------------------------

/** Domain separation for this encrypter's string secrets; the deterministic attribute cipher uses its own. */
const KEY_DERIVATION: AesKeyDerivation = Object.freeze({
  salt: Buffer.from('jsails/encryption/v1', 'utf8'),
  info: Buffer.from('aes-256-gcm', 'utf8'),
  label: 'encryption key',
});

/** Reject a non-plain-object options argument before crypto operations run. */
function assertPlainObject(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new EncryptionError('invalid_options', 'invalid encrypter options');
  }
}

// -- key material --------------------------------------------------------------

function resolveKeyMaterial(options: EncrypterOptions): {
  primary: Buffer;
  rotation: readonly Buffer[];
} {
  const primary = deriveAesKey(options.key, KEY_DERIVATION);

  const previous = options.previousKeys ?? [];
  const rotation: Buffer[] = [];
  for (let i = 0; i < previous.length; i++) {
    // Validate each previous key eagerly so a misconfigured rotation set fails
    // at construction rather than on the first decrypt call.
    try {
      rotation.push(deriveAesKey(previous[i]!, KEY_DERIVATION));
    } catch {
      throw new EncryptionError('invalid_key', `previous key at index ${i} is invalid`);
    }
  }

  return { primary, rotation };
}

// -- class ---------------------------------------------------------------------

/**
 * Symmetric AES-256-GCM encrypt/decrypt with key rotation.
 *
 * Construction validates the primary key and every `previousKeys` entry eagerly
 * (throwing `EncryptionError` with code `invalid_key` on failure) so a
 * misconfigured key set fails before any encrypt/decrypt call.
 *
 * The key material is held in ECMAScript `#private` fields — real runtime
 * encapsulation. Nominality is not a concern here because consumers type against
 * the structural {@link Encrypter} port, never against this class; the class is
 * assignable to the port through its public `encrypt`/`decrypt` methods.
 */
export class AesEncrypter implements Encrypter {
  readonly #primary: Buffer;
  readonly #rotation: readonly Buffer[];

  constructor(options: EncrypterOptions) {
    if (!isRecord(options)) {
      throw new EncryptionError('invalid_options', 'invalid encrypter options');
    }

    const { primary, rotation } = resolveKeyMaterial(options);
    this.#primary = primary;
    this.#rotation = rotation;
  }

  /** Encrypt `plaintext` and return a versioned envelope string. */
  encrypt(plaintext: string, opts?: EncryptOptions): string {
    assertPlainObject(opts);
    return sealEnvelope(this.#primary, randomAesIv(), plaintext, opts?.aad);
  }

  /**
   * Decrypt a versioned envelope. Tries the primary key first, then each entry
   * in `previousKeys` in order; returns the plaintext from the first that
   * authenticates.
   */
  decrypt(token: string, opts?: DecryptOptions): string {
    assertPlainObject(opts);
    const envelope = parseEnvelope(token);

    for (const keyBytes of [this.#primary, ...this.#rotation]) {
      try {
        return decryptEnvelope(keyBytes, envelope, opts?.aad);
      } catch {
        // This key does not authenticate the token; the next one may.
      }
    }

    throw new EncryptionError('decryption_failed', 'decryption failed');
  }
}
