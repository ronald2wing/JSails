/**
 * The `Encoding` namespace: base64, base64url, hex, data URLs, and random identifiers (nanoid, uuid) with value-free errors.
 */

import {
  assertString,
  assertPositiveInteger,
  type ArgumentErrorFactory,
} from '../validation/primitives.js';
import { decodeBase64Bytes, encodeBase64Bytes } from './base64.js';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

const ENCODING_ERRORS = {
  expected_string: {
    kind: 'internal',
    message: '{operation}: expected a string',
    context: { operation: 'identifier' },
  },
  expected_positive_integer: {
    kind: 'internal',
    message: '{operation}: expected a positive integer',
    context: { operation: 'identifier' },
  },
  expected_bytes: {
    kind: 'internal',
    message: '{operation}: expected a Uint8Array',
    context: { operation: 'identifier' },
  },
  expected_text_or_bytes: {
    kind: 'internal',
    message: '{operation}: expected a string or Uint8Array',
    context: { operation: 'identifier' },
  },
  encode_failed: {
    kind: 'internal',
    message: '{operation}: encoding failed',
    context: { operation: 'identifier' },
  },
  decode_failed: {
    kind: 'invalid',
    message: '{operation}: decoding failed',
    context: { operation: 'identifier' },
  },
} as const;

/**
 * The `Encoding` namespace's codes, `encoding.*`: input that does not decode
 * (`invalid`), and an argument of the wrong type (`internal`, the calling
 * code's bug). None echoes the input.
 *
 * @public
 */
export const EncodingErrors: ErrorRegistry<'encoding', typeof ENCODING_ERRORS> = defineErrors(
  'encoding',
  ENCODING_ERRORS,
);

const encodeError: ArgumentErrorFactory<'expected_string' | 'expected_positive_integer'> = (
  problem,
  operation,
) => new EncodingErrors.Error(problem, { operation });

// ---------------------------------------------------------------------------
// Validation helpers (value-free — never echo the offending value)
// ---------------------------------------------------------------------------

function assertUint8Array(value: unknown, operation: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new EncodingErrors.Error('expected_bytes', { operation: `Encoding.${operation}` });
  }
}

function assertUint8ArrayOrString(
  value: unknown,
  operation: string,
): asserts value is string | Uint8Array {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
    throw new EncodingErrors.Error('expected_text_or_bytes', {
      operation: `Encoding.${operation}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Standard base64 alphabet (RFC 4648 section 4). */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** URL-safe base64url alphabet — no padding after normalization. */
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/** True when `input` uses only the base64url alphabet (an empty string qualifies). */
export function isBase64url(input: string): boolean {
  return BASE64URL_RE.test(input);
}

/**
 * Convert a string to a binary string (each char holds one byte, charCode 0-255)
 * by UTF-8 encoding the text first. This produces a string safe for btoa.
 */
function textToBinaryString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
}

/**
 * Encode a string or Uint8Array to a base64 string.
 */
function encodeBase64(input: string | Uint8Array): string {
  if (typeof input === 'string') {
    const binStr = textToBinaryString(input);
    try {
      return btoa(binStr);
    } catch {
      throw new EncodingErrors.Error('encode_failed', { operation: 'Encoding.base64' });
    }
  }
  return encodeBase64Bytes(input);
}

/**
 * Decode a standard-base64 string to a Uint8Array.
 * Validates the alphabet before decoding; the decoder assumes a validated alphabet
 * invalid characters.
 */
function decodeBase64(input: string): Uint8Array {
  if (!BASE64_RE.test(input)) {
    throw new EncodingErrors.Error('decode_failed', { operation: 'Encoding.base64Decode' });
  }
  try {
    return decodeBase64Bytes(input);
  } catch {
    throw new EncodingErrors.Error('decode_failed', { operation: 'Encoding.base64Decode' });
  }
}

// ---------------------------------------------------------------------------
// Own: base64 (binary path)
// Native: btoa / atob (text path via UTF-8 encoding)
// ---------------------------------------------------------------------------

export function base64(input: string | Uint8Array): string {
  assertUint8ArrayOrString(input, 'base64');
  return encodeBase64(input);
}

export function base64Decode(input: string): Uint8Array {
  assertString(input, 'Encoding.base64Decode', encodeError);
  return decodeBase64(input);
}

// ---------------------------------------------------------------------------
// Own: base64url (RFC 4648 section 5)
// ---------------------------------------------------------------------------

export function base64url(input: string | Uint8Array): string {
  assertUint8ArrayOrString(input, 'base64url');
  return encodeBase64(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(input: string): Uint8Array {
  assertString(input, 'Encoding.base64urlDecode', encodeError);
  // Validate the base64url alphabet before normalizing — the decoder assumes a validated alphabet
  // invalid characters, so a string like "~~~" would decode to [0,0] instead of
  // failing.
  if (!isBase64url(input)) {
    throw new EncodingErrors.Error('decode_failed', { operation: 'Encoding.base64urlDecode' });
  }
  // Re-pad and restore standard alphabet.
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder) {
    normalized += '='.repeat(4 - remainder);
  }
  return decodeBase64(normalized);
}

// ---------------------------------------------------------------------------
// Own: hex
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hex(input: string | Uint8Array): string {
  assertUint8ArrayOrString(input, 'hex');
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return bytesToHex(bytes);
}

export function hexDecode(input: string): Uint8Array {
  assertString(input, 'Encoding.hexDecode', encodeError);

  if (input.length % 2 !== 0) {
    throw new EncodingErrors.Error('decode_failed', { operation: 'Encoding.hexDecode' });
  }

  const bytes = new Uint8Array(input.length / 2);
  for (let i = 0; i < input.length; i += 2) {
    const pair = input.slice(i, i + 2);
    const byte = parseInt(pair, 16);
    if (Number.isNaN(byte)) {
      throw new EncodingErrors.Error('decode_failed', { operation: 'Encoding.hexDecode' });
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Own: data URLs
// ---------------------------------------------------------------------------

export function toDataUrl(mime: string, data: Uint8Array): string {
  assertUint8Array(data, 'toDataUrl');
  assertString(mime, 'Encoding.toDataUrl', encodeError);
  return `data:${mime};base64,${encodeBase64Bytes(data)}`;
}

const DATA_URL_RE = /^data:([^;]*);base64,(.*)$/;

export interface DataUrlParts {
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export function parseDataUrl(input: string): DataUrlParts | null {
  if (typeof input !== 'string') return null;

  const match = DATA_URL_RE.exec(input);
  if (!match) return null;

  const mime = match[1]!;
  const payload = match[2]!;
  if (!BASE64_RE.test(payload)) return null;

  try {
    const bytes = decodeBase64Bytes(payload);
    return { mime, bytes };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Own: nanoid (URL-safe random id, default size 21)
// ---------------------------------------------------------------------------

const NANOID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const NANOID_DEFAULT_SIZE = 21;

export function nanoid(size?: number): string {
  const n = size ?? NANOID_DEFAULT_SIZE;
  assertPositiveInteger(n, 'Encoding.nanoid', encodeError);

  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);

  let id = '';
  for (let i = 0; i < n; i++) {
    id += NANOID_ALPHABET[bytes[i]! % NANOID_ALPHABET.length]!;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Native: crypto.randomUUID
// ---------------------------------------------------------------------------

export function uuid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Native: crypto.getRandomValues
// ---------------------------------------------------------------------------

export function randomBytes(size: number): Uint8Array {
  assertPositiveInteger(size, 'Encoding.randomBytes', encodeError);
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Serialize a JSON-compatible value deterministically, for use as a cache or
 * deduplication key: object keys are sorted at every depth, and `NaN` and
 * `±Infinity` become distinct string tokens instead of all collapsing to
 * `null`. Two structurally equal values always produce the same string.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '__NaN__';
    if (value === Infinity) return '__Infinity__';
    if (value === -Infinity) return '__-Infinity__';
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Encoding: Readonly<{
  base64: typeof base64;
  base64Decode: typeof base64Decode;
  base64url: typeof base64url;
  base64urlDecode: typeof base64urlDecode;
  isBase64url: typeof isBase64url;
  hex: typeof hex;
  hexDecode: typeof hexDecode;
  toDataUrl: typeof toDataUrl;
  parseDataUrl: typeof parseDataUrl;
  nanoid: typeof nanoid;
  uuid: typeof uuid;
  randomBytes: typeof randomBytes;
  canonicalJson: typeof canonicalJson;
}> = Object.freeze({
  base64,
  base64Decode,
  base64url,
  base64urlDecode,
  isBase64url,
  hex,
  hexDecode,
  toDataUrl,
  parseDataUrl,
  nanoid,
  uuid,
  randomBytes,
  canonicalJson,
});
