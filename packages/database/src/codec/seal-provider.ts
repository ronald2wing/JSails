/**
 * The seat of the seal layer: what an encryption keyring (DAT-10) supplies so
 * an encrypted column's codec can be built. The layer sits after the
 * portable layer, so it receives the column's portable stored form on the
 * dialect (text, a number, a bigint) and returns the envelope bytes the
 * column stores as `binary`; decoding reverses that. A deterministic mode
 * that must match values written under every ring key, or still as
 * plaintext, states each stored form through `encodeForLookup` and declares
 * itself `equality`; a random mode declares `none`.
 */

import type { Dialect, SqlValue } from '../engine/contract.js';
import type { EncryptionSpec, ResolvedColumn } from '../model/model-spec.js';
import type { CodecLayer } from './column-codec.js';

/** The column a seal layer is built for. */
export interface SealTarget {
  /** The physical table, the default additional authenticated data's first half. */
  readonly table: string;
  readonly column: ResolvedColumn;
  readonly encryption: EncryptionSpec;
  readonly dialect: Dialect;
}

/** Builds the seal layer of each encrypted column. */
export type SealProvider = (target: SealTarget) => CodecLayer<SqlValue, Uint8Array>;
