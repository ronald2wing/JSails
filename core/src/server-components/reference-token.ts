/**
 * Shared HMAC sign/verify for the server-component reference tokens.
 *
 * Upload references, download references, and signed snapshots all encode a
 * JSON payload as `<base64url payload>.<base64url HMAC>` and verify it with the
 * same MAC-first, timing-safe discipline. The sign and verify halves live here
 * so the three surfaces cannot drift on the security-sensitive encoding.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { isForbiddenKey, isPlainObject } from '../internal/json-safe.js';
import { BASE64URL_PATTERN, REFERENCE_VERSION, SIGNATURE_BYTES } from './reference-constants.js';

/**
 * Encode a JSON payload and sign it with an HMAC-SHA256 key, returning the
 * `<payload>.<signature>` token. `jsonBytes` is the UTF-8 JSON body; `signKey`
 * is the already-derived HMAC key.
 */
export function signJson(signKey: Buffer, jsonBytes: Buffer): string {
  const signature = createHmac('sha256', signKey).update(jsonBytes).digest('base64url');
  return `${jsonBytes.toString('base64url')}.${signature}`;
}

/**
 * Verify a `<payload>.<signature>` token and return the raw payload bytes.
 * `fail` (a no-return `never`-typed callback) is invoked on any structural or
 * MAC failure, so the caller controls the domain error; the token content is
 * never echoed. The payload is untrusted until the MAC matches (MAC-first).
 */
export function verifyAndDecode(
  token: string,
  signKey: Buffer,
  maxPayloadBytes: number,
  fail: () => never,
): Buffer {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    fail();
  }
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);
  if (!BASE64URL_PATTERN.test(payloadPart) || !BASE64URL_PATTERN.test(signaturePart)) {
    fail();
  }
  if (payloadPart.length % 4 === 1 || signaturePart.length % 4 === 1) {
    fail();
  }

  const payloadBytes = Buffer.from(payloadPart, 'base64url');
  const signatureBytes = Buffer.from(signaturePart, 'base64url');
  if (payloadBytes.byteLength > maxPayloadBytes || signatureBytes.byteLength !== SIGNATURE_BYTES) {
    fail();
  }

  // MAC first: the payload is untrusted until the signature matches.
  const expected = createHmac('sha256', signKey).update(payloadBytes).digest();
  // Raw 32-byte HMAC digests (arbitrary bytes), not text, so compare the
  // fixed-length buffers directly rather than a utf8-only string helper.
  if (!timingSafeEqual(expected, signatureBytes)) {
    fail();
  }

  return payloadBytes;
}

/** Bound on a token string length for a payload capped at `maxPayloadBytes`
 *  (base64url inflation + one separator + a 43-char base64url HMAC). */
export function maxTokenLength(maxPayloadBytes: number): number {
  return Math.ceil((maxPayloadBytes * 4) / 3) + 1 + 43;
}

/**
 * Verify a reference token, decode its JSON payload, and reject a non-object,
 * wrong-version, or prototype-polluting envelope. The caller then validates the
 * claims it expects. Every failure goes through `fail`; the token and payload
 * are never echoed.
 */
export function verifyReferenceEnvelope(
  token: string,
  signKey: Buffer,
  maxPayloadBytes: number,
  fail: () => never,
): Record<string, unknown> {
  if (typeof token !== 'string' || token.length > maxTokenLength(maxPayloadBytes)) {
    fail();
  }
  const payloadBytes = verifyAndDecode(token, signKey, maxPayloadBytes, fail);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    fail();
  }
  if (!isPlainObject(parsed) || parsed.v !== REFERENCE_VERSION) {
    fail();
  }
  for (const key of Object.keys(parsed)) {
    if (isForbiddenKey(key)) fail();
  }
  return parsed;
}
