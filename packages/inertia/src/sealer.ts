/**
 * Sealing for the flash and errors carrier: a structural {@link InertiaSealer}
 * port and two implementations.
 *
 * {@link webCryptoSealer} is the default: AES-256-GCM through Web Crypto with
 * a fresh 96-bit IV per seal and the caller's additional authenticated data,
 * so a token sealed for one purpose never opens for another. Its tokens are
 * `v1.` followed by base64url of IV and ciphertext with the tag; the version
 * prefix leaves room for a key id when sealing moves to a key ring.
 * {@link sealerFromEncrypter} adapts any synchronous encrypter with AAD
 * support (the core `AesEncrypter` among them) without importing it.
 *
 * `open` never throws for a bad token: a tampered, truncated, foreign, or
 * wrong-AAD token opens to `null`, which the carrier reads as empty.
 */

import { InertiaError } from './inertia-error.js';

/** Seals and opens carrier payloads, binding each to an AAD string. */
export interface InertiaSealer {
  seal(plaintext: string, aad: string): Promise<string>;
  /** The plaintext, or `null` when the token does not open under `aad`. */
  open(token: string, aad: string): Promise<string | null>;
}

/** The encrypter shape {@link sealerFromEncrypter} adapts. */
export interface AadEncrypter {
  encrypt(plaintext: string, options: { readonly aad: string }): string;
  /** Throws when the token does not decrypt under `aad`. */
  decrypt(token: string, options: { readonly aad: string }): string;
}

const TOKEN_PREFIX = 'v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * An AES-256-GCM sealer over Web Crypto. `key` is 32 raw bytes or an AES-GCM
 * `CryptoKey` usable for encryption and decryption.
 */
export function webCryptoSealer(key: Uint8Array | CryptoKey): InertiaSealer {
  const cryptoKey = importSealingKey(key);
  const encoder = new TextEncoder();
  return Object.freeze({
    async seal(plaintext: string, aad: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
        await cryptoKey,
        encoder.encode(plaintext),
      );
      const sealed = Buffer.concat([iv, new Uint8Array(ciphertext)]);
      return `${TOKEN_PREFIX}${sealed.toString('base64url')}`;
    },
    async open(token: string, aad: string): Promise<string | null> {
      if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
      const encoded = token.slice(TOKEN_PREFIX.length);
      if (!BASE64URL.test(encoded)) return null;
      const sealed = Buffer.from(encoded, 'base64url');
      if (sealed.length < IV_BYTES + TAG_BYTES) return null;
      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: sealed.subarray(0, IV_BYTES),
            additionalData: encoder.encode(aad),
          },
          await cryptoKey,
          sealed.subarray(IV_BYTES),
        );
        return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
      } catch {
        return null;
      }
    },
  });
}

/** Adapt a synchronous AAD-capable encrypter to the {@link InertiaSealer} port. */
export function sealerFromEncrypter(encrypter: AadEncrypter): InertiaSealer {
  if (
    typeof encrypter !== 'object' ||
    encrypter === null ||
    typeof encrypter.encrypt !== 'function' ||
    typeof encrypter.decrypt !== 'function'
  ) {
    throw new InertiaError('invalid_options');
  }
  return Object.freeze({
    seal(plaintext: string, aad: string): Promise<string> {
      return Promise.resolve(encrypter.encrypt(plaintext, { aad }));
    },
    open(token: string, aad: string): Promise<string | null> {
      try {
        return Promise.resolve(encrypter.decrypt(token, { aad }));
      } catch {
        return Promise.resolve(null);
      }
    },
  });
}

function importSealingKey(key: Uint8Array | CryptoKey): Promise<CryptoKey> {
  if (key instanceof Uint8Array) {
    if (key.length !== KEY_BYTES) throw new InertiaError('invalid_options');
    return crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  }
  if (
    key instanceof CryptoKey &&
    key.type === 'secret' &&
    key.algorithm.name === 'AES-GCM' &&
    key.usages.includes('encrypt') &&
    key.usages.includes('decrypt')
  ) {
    return Promise.resolve(key);
  }
  throw new InertiaError('invalid_options');
}
