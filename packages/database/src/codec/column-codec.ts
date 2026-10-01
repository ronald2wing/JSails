/**
 * The column codec contract and its chain. A column's codec is built from
 * layers applied in a fixed order on the way in (data contract, enum,
 * portable type, then seal and the stored binary type for an encrypted
 * column) and in reverse on the way out. The statement compiler encodes
 * every parameter and SET value through it; the hydrator decodes every
 * result column through it.
 *
 * `queryable` says which predicates the stored form can answer: `full`
 * (equality, ranges, `LIKE`, order), `equality`, or `none` (null tests
 * only). A chain is as queryable as its weakest layer. A layer whose
 * encoding is not a function of the value alone (an encryption under
 * several keys, a migration that also accepts plaintext) states every
 * stored form a value may have through `encodeForLookup`, and an equality
 * lookup then matches any of them.
 */

import type { SqlValue } from '../engine/contract.js';
import type { PortableType } from '../model/portable-type.js';
import { CodecErrors } from './codec-errors.js';

/** Which predicates a column's stored form can answer. */
export type Queryable = 'none' | 'equality' | 'full';

/** The codec of one column: application value in, bound value out, and back. */
export interface ColumnCodec<App = unknown, Db = SqlValue> {
  /** The portable type the column stores (`binary` for an encrypted column). */
  readonly dbType: PortableType;
  /** The stored form of a non-null value; throws a value-free error. */
  encode(value: App): Db;
  /** The application value of a non-null stored value; throws a value-free error. */
  decode(value: Db): App;
  readonly queryable: Queryable;
  /**
   * Every stored form `value` may have, for an equality lookup. Present only
   * when a value has more than one; otherwise a lookup binds `encode(value)`.
   */
  encodeForLookup?(value: App): readonly Db[];
}

/** One layer of a chain: what {@link ColumnCodec} is without the stored type. */
export type CodecLayer<Outer = unknown, Inner = unknown> = Omit<
  ColumnCodec<Outer, Inner>,
  'dbType'
>;

const RANK: Readonly<Record<Queryable, number>> = Object.freeze({
  none: 0,
  equality: 1,
  full: 2,
});

/** Whether `queryable` answers at least what `needed` asks for. */
export function supports(queryable: Queryable, needed: Exclude<Queryable, 'none'>): boolean {
  return RANK[queryable] >= RANK[needed];
}

/**
 * Chain `layers`, outermost (closest to the application) first, into the
 * codec of a column stored as `dbType`.
 */
export function chainCodecs(
  dbType: PortableType,
  layers: readonly CodecLayer[],
): ColumnCodec<unknown, SqlValue> {
  if (layers.length === 0) throw new CodecErrors.Error('invalid_chain');
  let queryable: Queryable = 'full';
  for (const layer of layers) {
    if (RANK[layer.queryable] < RANK[queryable]) queryable = layer.queryable;
  }
  const fansOut = layers.some((layer) => layer.encodeForLookup !== undefined);
  const encode = (value: unknown): SqlValue => {
    let current = value;
    for (const layer of layers) current = layer.encode(current);
    return current as SqlValue;
  };
  const decode = (value: SqlValue): unknown => {
    let current: unknown = value;
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      current = (layers[index] as CodecLayer).decode(current);
    }
    return current;
  };
  const codec: ColumnCodec<unknown, SqlValue> = {
    dbType,
    queryable,
    encode,
    decode,
    ...(fansOut
      ? {
          encodeForLookup: (value: unknown): readonly SqlValue[] => {
            let forms: unknown[] = [value];
            for (const layer of layers) {
              const next: unknown[] = [];
              for (const form of forms) {
                if (layer.encodeForLookup === undefined) next.push(layer.encode(form));
                else next.push(...layer.encodeForLookup(form));
              }
              forms = next;
            }
            return Object.freeze(forms as SqlValue[]);
          },
        }
      : {}),
  };
  return Object.freeze(codec);
}
