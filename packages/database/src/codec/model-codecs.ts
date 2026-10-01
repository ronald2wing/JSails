/**
 * The codecs of a model's columns on one dialect: each column's chain built
 * from its declaration (data contract, enum, portable type, then seal and
 * the stored binary for an encrypted column), with `NULL` handled here once
 * so no layer sees it. The statement compiler encodes through
 * {@link encodeColumn} and the hydrator decodes through {@link decodeColumn}.
 */

import type { Dialect, SqlValue } from '../engine/contract.js';
import { modelDefinition } from '../model/define-model.js';
import { ColumnValueError } from '../model/model-error.js';
import type { ModelTarget, NormalizedSpec, ResolvedColumn } from '../model/model-spec.js';
import { portableCodec } from '../model/portable-codec.js';
import { isOrdered } from '../model/portable-type.js';
import { storedType } from '../model/spec-validation.js';
import { CodecErrors } from './codec-errors.js';
import { chainCodecs, type CodecLayer, type ColumnCodec } from './column-codec.js';
import { dataContractCodec } from './data-contract-codec.js';
import { enumCodec } from './enum-codec.js';
import type { SealProvider } from './seal-provider.js';

/** One column of a model with its codec. */
export interface CodecColumn {
  /** The model property. */
  readonly property: string;
  /** The physical column name. */
  readonly column: string;
  readonly nullable: boolean;
  readonly resolved: ResolvedColumn;
  readonly codec: ColumnCodec;
}

/** Every column codec of one model on one dialect. */
export interface ModelCodecs {
  readonly target: ModelTarget;
  readonly spec: NormalizedSpec;
  readonly dialect: Dialect;
  /** In table order. */
  readonly columns: readonly CodecColumn[];
  /** The column of a property, or `undefined`. */
  property(name: string): CodecColumn | undefined;
}

/** Options of {@link modelCodecs}. */
export interface ModelCodecsOptions {
  /** Builds the seal layer of encrypted columns; without it they refuse to build. */
  readonly seal?: SealProvider;
}

function portableLayer(type: ResolvedColumn['type'], dialect: Dialect, field: string): CodecLayer {
  const codec = portableCodec(type, dialect, field);
  return Object.freeze({
    queryable: isOrdered(type) ? 'full' : 'none',
    encode: (value: unknown) => codec.encode(value as never),
    decode: (value: unknown) => codec.decode(value as SqlValue),
  } satisfies CodecLayer);
}

function columnCodec(
  spec: NormalizedSpec,
  column: ResolvedColumn,
  dialect: Dialect,
  seal: SealProvider | undefined,
): ColumnCodec {
  const field = column.property;
  const layers: CodecLayer[] = [];
  if (column.data !== undefined) layers.push(dataContractCodec(column.data, field));
  if (column.enum !== undefined) layers.push(enumCodec(column.enum, field));
  layers.push(portableLayer(column.type, dialect, field));
  const stored = storedType(column);
  if (column.encrypted !== undefined) {
    if (seal === undefined) {
      throw new CodecErrors.Error('missing_seal', { model: spec.name, field });
    }
    layers.push(seal({ table: spec.table, column, encryption: column.encrypted, dialect }));
    layers.push(portableLayer(stored, dialect, field));
  }
  return chainCodecs(stored, layers);
}

/**
 * The column codecs of `target` on `dialect`.
 *
 * @throws `codec.not_a_model` when `target` was not defined with
 *   `defineModel` or `defineTable`, and `codec.missing_seal` for an
 *   encrypted column without `options.seal`.
 */
export function modelCodecs(
  target: ModelTarget,
  dialect: Dialect,
  options: ModelCodecsOptions = {},
): ModelCodecs {
  const definition = modelDefinition(target);
  if (definition === undefined) throw new CodecErrors.Error('not_a_model');
  const { spec } = definition;
  const columns = spec.columns.map((column) =>
    Object.freeze({
      property: column.property,
      column: column.column,
      nullable: column.nullable,
      resolved: column,
      codec: columnCodec(spec, column, dialect, options.seal),
    } satisfies CodecColumn),
  );
  const byProperty = new Map(columns.map((column) => [column.property, column]));
  return Object.freeze({
    target,
    spec,
    dialect,
    columns: Object.freeze(columns),
    property: (name: string) => byProperty.get(name),
  });
}

/**
 * The bound value of `value` for `column`: `NULL` for `null` on a nullable
 * column, the codec's encoding otherwise.
 *
 * @throws {ColumnValueError} for `undefined`, `null` on a non-null column, or
 *   a value the codec refuses.
 */
export function encodeColumn(column: CodecColumn, value: unknown): SqlValue {
  if (value === null && column.nullable) return null;
  if (value === null || value === undefined) {
    throw new ColumnValueError('invalid_value', column.resolved.type.kind, column.property);
  }
  return column.codec.encode(value);
}

/**
 * The application value of a stored `value` of `column`.
 *
 * @throws {ColumnValueError} (`invalid_stored_value`) for `NULL` in a non-null
 *   column, or a value the codec refuses.
 */
export function decodeColumn(column: CodecColumn, value: SqlValue | undefined): unknown {
  if (value === null && column.nullable) return null;
  if (value === null || value === undefined) {
    throw new ColumnValueError('invalid_stored_value', column.resolved.type.kind, column.property);
  }
  return column.codec.decode(value);
}
