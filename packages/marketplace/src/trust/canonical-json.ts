/**
 * Canonical JSON: the one byte form of a value that a signature covers.
 *
 * It is RFC 8785 (the JSON Canonicalization Scheme) restricted to safe
 * integers: object members sorted by their keys' UTF-16 code units, no
 * insignificant whitespace, strings escaped exactly as ECMAScript's
 * `JSON.stringify` escapes them (which is what RFC 8785 specifies), and
 * numbers only as integers within ±(2^53 - 1), so the serialisation of a
 * number never depends on a float formatting algorithm. Values are `null`,
 * booleans, those integers, well-formed strings (no lone surrogate), arrays
 * and plain objects, nested at most 32 deep; `undefined` is not a value. With
 * no floats in play, any RFC 8785 implementation produces the same bytes,
 * which is what lets a publisher sign with other tooling.
 */

import { isWellFormedText } from '../archive/well-formed.js';
import { MarketplaceConfigErrors } from './config-errors.js';

const MAX_DEPTH = 32;

type Problem = 'number' | 'string' | 'undefined' | 'type' | 'depth';

function notCanonical(problem: Problem): Error {
  return new MarketplaceConfigErrors.Error('not_canonical', { problem });
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serialise(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw notCanonical('depth');
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw notCanonical('number');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') {
    if (!isWellFormedText(value)) throw notCanonical('string');
    return JSON.stringify(value);
  }
  if (value === undefined) throw notCanonical('undefined');
  if (Array.isArray(value)) {
    // `Array.from` visits holes as `undefined`, which is refused like any other.
    return `[${Array.from(value as readonly unknown[], (item) => serialise(item, depth + 1)).join(',')}]`;
  }
  if (typeof value !== 'object' || !isPlainObject(value)) throw notCanonical('type');
  const record = value as Readonly<Record<string, unknown>>;
  const members = Object.keys(record)
    .sort()
    .map((key) => {
      if (!isWellFormedText(key)) throw notCanonical('string');
      return `${JSON.stringify(key)}:${serialise(record[key], depth + 1)}`;
    });
  return `{${members.join(',')}}`;
}

/**
 * The canonical JSON text of `value`. Throws
 * `marketplace_config.not_canonical` for a value outside the canonical subset.
 *
 * @public
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, 0);
}
