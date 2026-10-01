/**
 * Column codecs and the owned hydrator: the `ColumnCodec` contract and its
 * layered chain (data contract, enum, portable type, seal), the codecs of a
 * model's columns on a dialect, and the mapping of result rows to records
 * with their hidden state slot, or to plain projections.
 */

export { CodecErrors } from './codec-errors.js';
export {
  chainCodecs,
  supports,
  type CodecLayer,
  type ColumnCodec,
  type Queryable,
} from './column-codec.js';
export { dataContractCodec } from './data-contract-codec.js';
export { enumCodec } from './enum-codec.js';
export {
  createRecordState,
  decodeRow,
  hydrate,
  persistedState,
  RECORD_STATE,
  recordState,
  setRecordState,
  type PolymorphicKey,
  type RecordState,
} from './hydrate.js';
export {
  decodeColumn,
  encodeColumn,
  modelCodecs,
  type CodecColumn,
  type ModelCodecs,
  type ModelCodecsOptions,
} from './model-codecs.js';
export type { SealProvider, SealTarget } from './seal-provider.js';
