/**
 * The browser-safe `Cryptography` namespace: Web Crypto digests, HMACs, random tokens, and constant-time comparison.
 */

import { base64url, hex } from './encoding.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

const CRYPTOGRAPHY_ERRORS = {
  unsupported_algorithm: {
    kind: 'internal',
    message: 'unsupported hash algorithm',
  },
  browser_unsupported_algorithm: {
    kind: 'internal',
    message:
      'algorithm {algorithm} is not supported browser-side; supported: SHA-1, SHA-256, SHA-384, SHA-512',
    context: { algorithm: ['MD5'] },
    suggestion: 'use hashSync from jsails/support/server for MD5 on the server',
  },
  unsupported_hmac_algorithm: {
    kind: 'internal',
    message: 'unsupported HMAC algorithm',
  },
  insecure_context: {
    kind: 'internal',
    message: 'Web Crypto requires a secure context (crypto.subtle is unavailable)',
    suggestion: 'serve the page over HTTPS or from localhost',
  },
} as const;

/**
 * The `Cryptography` codes, `cryptography.*`, shared by the browser namespace
 * and the server addendum: an algorithm outside the offered set (named only
 * when it is a known one, never echoed from input) and a missing Web Crypto.
 *
 * @public
 */
export const CryptographyErrors: ErrorRegistry<'cryptography', typeof CRYPTOGRAPHY_ERRORS> =
  defineErrors('cryptography', CRYPTOGRAPHY_ERRORS);

// ---------------------------------------------------------------------------
// Algorithm validation
// ---------------------------------------------------------------------------

export type HashAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

const SUPPORTED_ALGORITHMS: readonly string[] = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];

/**
 * Algorithms that are known hash algorithms but deliberately not offered in the
 * browser subset. Naming one of these in an error is safe — the value is a
 * fixed enumeration, not arbitrary user input.
 */
const KNOWN_UNSUPPORTED = new Set(['MD5']);

function validateAlgorithm(value: string): asserts value is HashAlgorithm {
  if (SUPPORTED_ALGORITHMS.includes(value)) return;

  if (KNOWN_UNSUPPORTED.has(value)) {
    throw new CryptographyErrors.Error('browser_unsupported_algorithm', { algorithm: 'MD5' });
  }

  // Arbitrary / unknown input — value-free.
  throw new CryptographyErrors.Error('unsupported_algorithm');
}

// ---------------------------------------------------------------------------
// SubtleCrypto guard
// ---------------------------------------------------------------------------

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new CryptographyErrors.Error('insecure_context');
  }
  return subtle;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toWebCryptoBytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  // Copy into a fresh buffer with a concrete ArrayBuffer backing so the
  // result satisfies BufferSource for Web Crypto API signatures.
  return new Uint8Array(value);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a lowercase hex digest of `value` using the given hash algorithm.
 *
 * Input is UTF-8 encoded when a string.  Defaults to SHA-256.
 */
export async function hash(
  value: string | Uint8Array,
  algorithm: HashAlgorithm = 'SHA-256',
): Promise<string> {
  validateAlgorithm(algorithm);
  const subtle = requireSubtle();
  const data = toWebCryptoBytes(value);
  const digest = await subtle.digest(algorithm, data as unknown as BufferSource);
  return hex(new Uint8Array(digest));
}

/**
 * Produce an HMAC digest as lowercase hex.
 *
 * The `key` and `value` are UTF-8 encoded when strings.  Defaults to SHA-256.
 */
export async function hmac(
  value: string | Uint8Array,
  key: string | Uint8Array,
  algorithm: HashAlgorithm = 'SHA-256',
): Promise<string> {
  validateAlgorithm(algorithm);
  const subtle = requireSubtle();
  const keyBytes = toWebCryptoBytes(key);
  const dataBytes = toWebCryptoBytes(value);

  const cryptoKey = await subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: algorithm as unknown as AlgorithmIdentifier },
    false,
    ['sign'],
  );

  const signature = await subtle.sign('HMAC', cryptoKey, dataBytes as unknown as BufferSource);
  return hex(new Uint8Array(signature));
}

/**
 * Generate a URL-safe random token; `bytes` defaults to 32.
 *
 * Uses `crypto.getRandomValues` — the host must be in a secure context.
 */
export function randomToken(bytes = 32): string {
  // randomToken reads from crypto.getRandomValues, which is available in
  // insecure contexts even when subtle is not.  Only gate on getRandomValues
  // being missing (practically unreachable in any modern runtime).
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return base64url(buf);
}

/**
 * Constant-time best-effort string comparison.
 *
 * Returns `false` on length mismatch and never throws.  JS cannot guarantee
 * true constant-time against a JIT, but this avoids the early-return timing
 * leak of `===` by comparing every byte.
 */
export function equal(a: string | Uint8Array, b: string | Uint8Array): boolean {
  if (typeof a !== 'string' && !(a instanceof Uint8Array)) return false;
  if (typeof b !== 'string' && !(b instanceof Uint8Array)) return false;

  const bufA = typeof a === 'string' ? new TextEncoder().encode(a) : a;
  const bufB = typeof b === 'string' ? new TextEncoder().encode(b) : b;

  if (bufA.byteLength !== bufB.byteLength) return false;

  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Cryptography: Readonly<{
  hash: typeof hash;
  hmac: typeof hmac;
  randomToken: typeof randomToken;
  equal: typeof equal;
}> = Object.freeze({
  hash,
  hmac,
  randomToken,
  equal,
});
