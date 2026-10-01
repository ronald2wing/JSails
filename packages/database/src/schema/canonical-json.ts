/**
 * Canonical JSON and its digest: object keys sorted, no whitespace, so two
 * structurally equal values serialise to the same text. The plan's approval
 * digests, the applied-schema digest and JSON default comparison use it.
 */

import { createHash } from 'node:crypto';

/** `value` as JSON with every object's keys in code-unit order; `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('hex'));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  return JSON.stringify(value) ?? 'null';
}

/** The SHA-256 of `value`'s canonical JSON, as hex. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
