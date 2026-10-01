/**
 * The enum layer of a column codec: a `string` column declared with `enum`
 * accepts exactly those values when written and when read back, so a value a
 * migration or a hand-written statement left behind surfaces as an error
 * instead of reaching the application as a member of the union.
 */

import { ColumnValueError } from '../model/model-error.js';
import type { CodecLayer } from './column-codec.js';

/** The enum layer for a column whose values are `members`. */
export function enumCodec(members: readonly string[], field: string): CodecLayer {
  const allowed = new Set(members);
  return Object.freeze({
    queryable: 'full',
    encode: (value: unknown) => {
      if (typeof value !== 'string' || !allowed.has(value)) {
        throw new ColumnValueError('invalid_value', 'string', field);
      }
      return value;
    },
    decode: (value: unknown) => {
      if (typeof value !== 'string' || !allowed.has(value)) {
        throw new ColumnValueError('invalid_stored_value', 'string', field);
      }
      return value;
    },
  } satisfies CodecLayer);
}
