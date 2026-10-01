/**
 * The asset version hash.
 *
 * The client sends the version of the assets it booted with; a mismatch on a
 * GET visit forces a full reload. `inertiaVersion` derives that version from
 * an asset map (logical name to content hash or URL): SHA-256 over the
 * canonical JSON of the `[key, value]` pairs sorted by key, base64url, first 16
 * characters (96 bits). Keys and values are both hashed and JSON framing
 * separates them, so `{ a: 'bc' }` and `{ ab: 'c' }` differ, and so does a
 * renamed asset with an unchanged content hash.
 */

import { createHash } from 'node:crypto';

import { InertiaError } from './inertia-error.js';

/** Derive the Inertia asset version from an asset map. */
export function inertiaVersion(entries: Readonly<Record<string, string>>): string {
  if (typeof entries !== 'object' || entries === null) throw new InertiaError('invalid_options');
  const pairs = Object.keys(entries)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => {
      const value: unknown = entries[key];
      if (typeof value !== 'string') throw new InertiaError('invalid_options');
      return [key, value];
    });
  return createHash('sha256').update(JSON.stringify(pairs)).digest('base64url').slice(0, 16);
}
