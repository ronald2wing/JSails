/**
 * The field rules signed records and trust config share: closed objects,
 * timestamps in one spelling, key and publisher ids, credential-free https
 * URLs, and the signature list every envelope carries. Each check answers yes
 * or no; the caller turns a no into its own value-free code.
 */

import { isWellFormedText } from '../archive/well-formed.js';
import { isSignatureText } from './signature.js';

/**
 * A publisher id: lowercase letters, digits and dashes, as in a manifest.
 *
 * @public
 */
export const PUBLISHER_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A key id, unique within its publisher.
 *
 * @public
 */
export const KEY_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One signature of a signed record.
 *
 * @public
 */
export interface RecordSignature {
  readonly keyId: string;
  /** Standard padded base64 of the 64-byte Ed25519 signature. */
  readonly sig: string;
}

/** At most this many signatures are read from one record, bounding verification work. */
export const MAX_SIGNATURES = 8;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_URL_LENGTH = 2_048;

/** Whether `value` is a plain object, as `JSON.parse` returns one. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether `record` has every `required` key and no key outside `required` and `optional`. */
export function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  for (const key of required) if (!Object.hasOwn(record, key)) return false;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) return false;
  }
  return true;
}

/** Whether `value` is a UTC timestamp in `Date#toISOString` form (millisecond precision, `Z`). */
export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Whether `value` is a string matching `pattern`. */
export function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

/** Whether `value` is a non-empty single-line string of at most `max` characters. */
export function isLine(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    value.trim() !== '' &&
    !/[\r\n]/.test(value) &&
    isWellFormedText(value)
  );
}

/** Whether `value` is a credential-free `https:` URL of at most 2,048 characters. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL; the caller reports its own value-free code.
    return false;
  }
  return (
    url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== ''
  );
}

/**
 * The signatures of an envelope: 1 to {@link MAX_SIGNATURES} closed
 * `{ keyId, sig }` objects with distinct key ids and canonical base64
 * signatures; `undefined` when the list breaks any of that.
 */
export function parseSignatures(value: unknown): readonly RecordSignature[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SIGNATURES) return undefined;
  const seen = new Set<string>();
  const signatures: RecordSignature[] = [];
  for (const entry of value as readonly unknown[]) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['keyId', 'sig'])) return undefined;
    const { keyId, sig } = entry;
    if (!matches(keyId, KEY_ID_PATTERN) || typeof sig !== 'string' || !isSignatureText(sig)) {
      return undefined;
    }
    if (seen.has(keyId)) return undefined;
    seen.add(keyId);
    signatures.push(Object.freeze({ keyId, sig }));
  }
  return Object.freeze(signatures);
}
