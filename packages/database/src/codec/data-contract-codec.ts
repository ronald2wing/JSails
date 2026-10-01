/**
 * The data-contract layer of a `json` column's codec: a value is parsed
 * through the column's contract before it is written, and a stored value is
 * parsed through it again when read, so the application only ever holds a
 * value the contract accepts. What gets written is the contract's output (its
 * defaults applied, unknown keys of a strict contract refused). The parse
 * error is dropped: it quotes the value, which may be secret.
 */

import { ColumnValueError } from '../model/model-error.js';
import type { ColumnDataContract } from '../model/model-spec.js';
import type { CodecLayer } from './column-codec.js';

function parse(
  contract: ColumnDataContract,
  value: unknown,
  failure: 'invalid_value' | 'invalid_stored_value',
  field: string,
): unknown {
  const result = contract.schema.safeParse(value);
  if (result.success !== true) throw new ColumnValueError(failure, 'json', field);
  return result.data;
}

/** The data-contract layer for a column holding values of `contract`. */
export function dataContractCodec(contract: ColumnDataContract, field: string): CodecLayer {
  return Object.freeze({
    // The stored text is JSON whose key order is the application's, so even
    // equality on it would compare spelling, not values.
    queryable: 'none',
    encode: (value: unknown) => parse(contract, value, 'invalid_value', field),
    decode: (value: unknown) => parse(contract, value, 'invalid_stored_value', field),
  } satisfies CodecLayer);
}
