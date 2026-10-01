/**
 * The signed reference-token format shared by the server-component signers.
 *
 * Upload references, download references, and signed snapshots all encode a
 * JSON payload as `<base64url payload>.<base64url HMAC>`, verify it with the
 * same MAC-first, timing-safe discipline, and validate the same key bytes,
 * path-segment and content-type charsets. Everything security-sensitive about
 * that encoding lives here so the three surfaces cannot drift apart, and
 * {@link createReferenceSigner} is the whole upload/download signer: those
 * modules contribute only a claims schema, an HMAC context, and an error class.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { isForbiddenKey, isPlainObject } from '../json/shape.js';
import { Encoding } from '../support/encoding.js';

/** Safe path-segment charset: base64url and hex only, bounded length. */
export const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A content type is a non-empty `type/subtype` string without control characters. */
export const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;

/** Minimum signing-key length in bytes (the HMAC-SHA256 key floor). */
export const MIN_KEY_BYTES = 32;

/** HMAC-SHA256 signature length in bytes. */
const SIGNATURE_BYTES = 32;

/** Current reference-token payload version. */
export const REFERENCE_VERSION = 1;

/** Coerce a signing key to a `Buffer`, invoking `fail` for a wrong type. */
export function normalizeKey(
  key: string | Uint8Array,
  fail: (code: 'invalid_input', message: string) => never,
): Buffer {
  if (typeof key === 'string') return Buffer.from(key, 'utf8');
  if (key instanceof Uint8Array) return Buffer.from(key);
  return fail('invalid_input', 'reference key must be a string or Uint8Array');
}

/** Validate one claim of a reference payload, returning it typed or calling `fail`. */
export type ClaimValidator<T> = (value: unknown, fail: () => never) => T;

/** Validate a reference's id claim: a safe path segment. */
export function validateReferenceSegment(value: unknown, fail: () => never): string {
  if (typeof value !== 'string' || !SAFE_SEGMENT_PATTERN.test(value)) {
    fail();
  }
  return value;
}

/** Validate a reference's content-type claim against {@link CONTENT_TYPE_PATTERN}. */
export function validateReferenceContentType(value: unknown, fail: () => never): string {
  if (typeof value !== 'string' || !CONTENT_TYPE_PATTERN.test(value)) {
    fail();
  }
  return value;
}

/** Validate a reference's component claim: non-empty, `<= 255` chars. */
export function validateReferenceComponent(value: unknown, fail: () => never): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 255) {
    fail();
  }
  return value;
}

/**
 * Validate a reference's nullable subject claim: `null` allowed, else a safe
 * path segment. The snapshot signer keeps its own stricter subject semantics.
 */
export function validateReferenceSubject(value: unknown, fail: () => never): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SAFE_SEGMENT_PATTERN.test(value)) {
    fail();
  }
  return value;
}

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
  if (!Encoding.isBase64url(payloadPart) || !Encoding.isBase64url(signaturePart)) {
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

// ---------------------------------------------------------------------------
// Reference signer
// ---------------------------------------------------------------------------

function validateExpiresAt(value: unknown, fail: () => never): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail();
  }
  return value;
}

/** The claims every reference carries on top of its schema: the payload version and expiry. */
export interface ReferenceEnvelopeClaims {
  readonly v: typeof REFERENCE_VERSION;
  readonly expiresAt: number;
}

/** One validator per caller-supplied claim; the payload is built in this key order. */
export type ReferenceClaimsSchema<TClaims> = {
  readonly [K in keyof TClaims]-?: ClaimValidator<TClaims[K]>;
};

/** A configured reference signer: signs caller claims and verifies tokens back into them. */
export interface ReferenceSigner<TClaims> {
  sign(claims: TClaims): string;
  verify(token: string): TClaims & ReferenceEnvelopeClaims;
}

/** The two failure classes a reference signer reports through `makeError`. */
export type ReferenceSignerFailure = 'invalid_input' | 'invalid_reference';

/** Options for {@link createReferenceSigner}. */
export interface ReferenceSignerOptions<TClaims> {
  /** Master signing key (>= 32 bytes). Shared with the snapshot signer. */
  readonly key: string | Uint8Array;
  /** Time source returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Reference lifetime in milliseconds. Must be a positive finite number. */
  readonly ttlMs: number;
  /** HMAC domain context, distinct per signer so tokens never cross surfaces. */
  readonly context: string;
  /** Upper bound on a serialized payload, in bytes. */
  readonly maxPayloadBytes: number;
  /** Capitalized surface name for messages, e.g. `Upload`. */
  readonly label: string;
  /** The caller-supplied claims and how each is validated on sign and verify. */
  readonly claims: ReferenceClaimsSchema<TClaims>;
  /** Builds the surface's own value-free error; `invalid_input` is a caller mistake, `invalid_reference` a bad token. */
  readonly makeError: (failure: ReferenceSignerFailure, message: string) => Error;
}

/**
 * Create a reference signer over a master key. The key must be at least 32
 * bytes and `ttlMs` positive. Every claim in the schema is validated both when
 * signing and when verifying, and the HMAC key is derived under `context` so a
 * reference can never be forged from a snapshot signature or another surface's
 * reference without the master key.
 */
export function createReferenceSigner<TClaims extends Record<string, unknown>>(
  options: ReferenceSignerOptions<TClaims>,
): ReferenceSigner<TClaims> {
  const { label, makeError } = options;
  const invalidReference = (): never => {
    throw makeError('invalid_reference', `Invalid ${label.toLowerCase()} reference`);
  };
  const key = normalizeKey(options.key, () => {
    throw makeError('invalid_input', `${label} reference key must be a string or Uint8Array`);
  });
  if (key.byteLength < MIN_KEY_BYTES) {
    throw makeError('invalid_input', `${label} reference key must be at least 32 bytes`);
  }
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw makeError('invalid_input', 'ttlMs must be a positive finite number');
  }
  const claimNames = Object.keys(options.claims) as (keyof TClaims & string)[];
  const signKey = createHmac('sha256', key).update(options.context).digest();

  const validateClaims = (source: Record<string, unknown>): TClaims => {
    const validated: Record<string, unknown> = {};
    for (const name of claimNames) {
      validated[name] = options.claims[name](source[name], invalidReference);
    }
    return validated as TClaims;
  };

  return Object.freeze({
    sign(claims: TClaims): string {
      if (!isPlainObject(claims)) {
        throw makeError('invalid_input', `${label} reference claims must be an object`);
      }
      const expiresAt = now() + ttlMs;
      if (!Number.isFinite(expiresAt)) {
        throw makeError('invalid_input', `${label} signer clock produced a non-finite time`);
      }
      const payload = { v: REFERENCE_VERSION, ...validateClaims(claims), expiresAt };
      return signJson(signKey, Buffer.from(JSON.stringify(payload), 'utf8'));
    },

    verify(token: string): TClaims & ReferenceEnvelopeClaims {
      const parsed = verifyReferenceEnvelope(
        token,
        signKey,
        options.maxPayloadBytes,
        invalidReference,
      );
      const expiresAt = validateExpiresAt(parsed.expiresAt, invalidReference);
      if (expiresAt <= now()) {
        invalidReference();
      }
      return { v: REFERENCE_VERSION, ...validateClaims(parsed), expiresAt };
    },
  });
}
