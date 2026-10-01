/**
 * Ed25519 signatures over canonical JSON, through `node:crypto`.
 *
 * The signed message is a domain tag, `jsails.marketplace.<kind>.v1` and a
 * newline, followed by the canonical JSON of the record (`canonical-json.ts`),
 * all UTF-8. The tag names the record kind, so a signature made over a release
 * statement can never verify as a catalog or a delegation, whatever their
 * fields. A public key is the standard, padded base64 of its 32 raw bytes, and
 * a signature the standard, padded base64 of its 64 bytes; both must be in
 * exactly that form, so one key or signature has one spelling.
 */

import { createPublicKey, verify, type KeyObject } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';

/**
 * The kinds of signed record.
 *
 * @public
 */
export type SignedRecordKind = 'release' | 'catalog' | 'delegation';

const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const encoder = new TextEncoder();

/**
 * The exact bytes a publisher signs for a record of `kind`: the domain tag
 * line and the record's canonical JSON. Throws
 * `marketplace_config.not_canonical` for a record outside the canonical subset.
 *
 * @public
 */
export function signingMessage(kind: SignedRecordKind, record: unknown): Uint8Array {
  return encoder.encode(`jsails.marketplace.${kind}.v1\n${canonicalJson(record)}`);
}

/** The bytes of `text` when it is canonical padded base64 of exactly `length` bytes. */
function decodeBase64(text: string, length: number): Buffer | undefined {
  if (text.length !== Math.ceil(length / 3) * 4 || !BASE64.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length === length && bytes.toString('base64') === text ? bytes : undefined;
}

/** Whether `text` is a canonical base64 Ed25519 signature. */
export function isSignatureText(text: string): boolean {
  return decodeBase64(text, SIGNATURE_BYTES) !== undefined;
}

/** The key object for a canonical base64 Ed25519 public key, or `undefined`. */
export function decodePublicKey(text: string): KeyObject | undefined {
  const raw = decodeBase64(text, PUBLIC_KEY_BYTES);
  if (raw === undefined) return undefined;
  try {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
  } catch {
    // Not a point on the curve; the caller reports its own value-free code.
    return undefined;
  }
}

/** Whether `signature` (canonical base64) is a valid Ed25519 signature of `message` by `key`. */
export function verifySignature(message: Uint8Array, signature: string, key: KeyObject): boolean {
  const bytes = decodeBase64(signature, SIGNATURE_BYTES);
  if (bytes === undefined) return false;
  try {
    return verify(null, message, key, bytes);
  } catch {
    // A malformed signature is a failed verification, not an error.
    return false;
  }
}
